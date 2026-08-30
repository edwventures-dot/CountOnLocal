/**
 * Turning a pending subscription into an active one.
 *
 * `createSubscription` deliberately stops short of money: it writes a
 * `pending` row and the first horizon of occurrences, and nothing is
 * charged. This is the other half -- collect a card, charge the first
 * cycle, and let the customer onto the route.
 *
 * ## Card details never reach this server
 *
 * `startCardSetup` returns a processor client secret. The browser confirms
 * the card directly with Stripe and gets back a payment-method reference,
 * which is the only thing this endpoint ever sees. No number, no CVC, no
 * expiry. That is not merely a convenience -- accepting a card number here
 * would put this repository in PCI scope, and the provider on the other end
 * of it is frequently fourteen.
 *
 * ## Everything is re-checked, because pending can sit for days
 *
 * Between `createSubscription` and this call the route can fill, a guardian
 * can revoke, a provider can be suspended, or a business can be
 * unpublished. Trusting the checks that passed when the row was written
 * would let a revocation be outrun by a slow checkout.
 *
 * `canAcceptNewSubscription` is the one that matters most. CLAUDE.md rule 2
 * and QA_ACCEPTANCE section 3 -- "revocation immediately prevents new
 * checkout" -- mean a minor whose guardian has not reached `verified`
 * cannot take a paying customer, and this is the moment that becomes true
 * or false. The gate existed and was unit-tested before this file; nothing
 * in a live path called it. This is that call site.
 *
 * ## Order of operations, and why
 *
 * 1. Load, authorise, gate, re-check capacity. No writes.
 * 2. Price the cycle, applying any referral discount.
 * 3. Store the processor references on the still-pending row.
 * 4. Charge, keyed on (subscription, cycle start).
 * 5. Write the ledger.
 * 6. Mark the referral discount spent.
 * 7. Activate.
 *
 * Storing the references before charging (3 before 4) means a crash in the
 * middle leaves a pending row that names the card it was about to use,
 * rather than a charge nobody can trace to a method. It is safe because
 * `active_needs_payment_method` only constrains active rows -- a pending
 * row carrying a method is a subscription part-way through checkout, which
 * is exactly what it is.
 *
 * Charging before the ledger (4 before 5) matches settlement, for the
 * reason stated there: money taken with no ledger row is visible and
 * repairable from the processor's records, whereas a ledger claiming money
 * that was never taken looks right and is not.
 *
 * Activating last (7) means every failure leaves the subscription pending
 * and retryable. The idempotency key is what makes the retry safe: the
 * processor returns the original charge rather than making a second, and
 * the unique index on the ledger refuses the duplicate row.
 */

import { canAcceptNewSubscription } from '@/domain/gates'
import { canMoveSubscription } from '@/domain/subscription'
import { quoteCycle, type CycleQuote, type PriceUnit } from '@/domain/money'
import { cycleChargeKey, chargeEntries } from '@/domain/ledger'
import { loadProviderGateContext } from '@/server/providerGate'
import { markDiscountSpent, quoteWithReferral } from '@/server/referralService'
import { writeBalancedEntries } from '@/server/ledgerWriter'
import { getCharger } from '@/server/charger'
import { writeAudit } from '@/server/audit'
import { noticeToProviderAndGuardian } from '@/server/providerNotices'
import type { Role } from '@/domain/roles'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'
import { z } from 'zod'

type Db = SupabaseClient<Database>

export const activateSchema = z.object({
  /**
   * A processor-side reference, not a card. Bounded and shape-checked only
   * loosely: the processor is the authority on whether it is real, and
   * guessing at its format here would break the first time they change it.
   */
  paymentMethodRef: z.string().trim().min(3).max(255),
})
export type ActivateInput = z.infer<typeof activateSchema>

export type ActivationFailure =
  | 'NOT_FOUND'
  | 'NOT_YOUR_SUBSCRIPTION'
  | 'NOT_PENDING'
  | 'GUARDIAN_APPROVAL_REQUIRED'
  | 'PROVIDER_NOT_ELIGIBLE'
  | 'AT_CAPACITY'
  | 'NO_CYCLE'
  | 'QUOTE_MISMATCH'
  | 'CARD_DECLINED'
  | 'PROCESSOR_ERROR'
  | 'LEDGER_WRITE_FAILED'
  | 'WRITE_FAILED'

export type ActivationResult =
  | {
      ok: true
      state: 'active'
      chargedCents: number
      referralDiscountCents: number
      quote: CycleQuote
      externalId: string | null
    }
  | { ok: false; code: ActivationFailure; message: string }

export type CardSetupResult =
  | { ok: true; clientSecret: string; customerRef: string }
  | { ok: false; code: 'NOT_FOUND' | 'NOT_YOUR_SUBSCRIPTION' | 'NOT_PENDING' | 'PROCESSOR_ERROR' | 'WRITE_FAILED'; message: string }

type Loaded = {
  id: string
  customerUserId: string
  state: string
  providerUserId: string
  providerServiceId: string
  priceCents: number
  priceUnit: PriceUnit
  billingCycleWeeks: number
  feeBps: number
  feeMinCents: number
  cycleStart: string | null
  cycleEnd: string | null
  capacityMax: number
  stripeCustomerId: string | null
}

async function load(db: Db, subscriptionId: string): Promise<Loaded | null> {
  const { data } = await db
    .from('subscriptions')
    .select(
      `id, customer_user_id, state, provider_price_cents, price_unit, billing_cycle_weeks,
       platform_fee_bps, platform_fee_min_cents, current_cycle_start, current_cycle_end,
       stripe_customer_id, provider_service_id,
       provider_services!inner ( capacity_rule, businesses!inner ( provider_user_id ) )`,
    )
    .eq('id', subscriptionId)
    .maybeSingle()

  if (!data) return null

  const row = data as unknown as Record<string, unknown> & { provider_services: unknown }
  const svc = (Array.isArray(row.provider_services) ? row.provider_services[0] : row.provider_services) as
    | { capacity_rule: Record<string, unknown> | null; businesses: unknown }
    | undefined
  const biz = (Array.isArray(svc?.businesses) ? svc?.businesses[0] : svc?.businesses) as
    | { provider_user_id: string }
    | undefined
  if (!biz) return null

  return {
    id: row['id'] as string,
    customerUserId: row['customer_user_id'] as string,
    state: row['state'] as string,
    providerUserId: biz.provider_user_id,
    providerServiceId: row['provider_service_id'] as string,
    priceCents: row['provider_price_cents'] as number,
    priceUnit: row['price_unit'] as PriceUnit,
    billingCycleWeeks: row['billing_cycle_weeks'] as number,
    feeBps: row['platform_fee_bps'] as number,
    feeMinCents: row['platform_fee_min_cents'] as number,
    cycleStart: (row['current_cycle_start'] as string | null) ?? null,
    cycleEnd: (row['current_cycle_end'] as string | null) ?? null,
    capacityMax: Number(svc?.capacity_rule?.['maxAddresses'] ?? NaN),
    stripeCustomerId: (row['stripe_customer_id'] as string | null) ?? null,
  }
}

/**
 * Opens card collection for a pending subscription.
 *
 * Creates the processor customer on first call and reuses it after, so a
 * customer who abandons the form and comes back does not accumulate one
 * processor record per attempt.
 */
export async function startCardSetup(args: {
  db: Db
  subscriptionId: string
  actorUserId: string
}): Promise<CardSetupResult> {
  const sub = await load(args.db, args.subscriptionId)
  if (!sub) return { ok: false, code: 'NOT_FOUND', message: 'No such subscription.' }
  if (sub.customerUserId !== args.actorUserId) {
    return {
      ok: false,
      code: 'NOT_YOUR_SUBSCRIPTION',
      message: 'Only the customer on this subscription can pay for it.',
    }
  }
  if (sub.state !== 'pending') {
    return { ok: false, code: 'NOT_PENDING', message: `This subscription is already ${sub.state}.` }
  }

  const charger = getCharger()
  let customerRef = sub.stripeCustomerId

  if (!customerRef) {
    const created = await charger.ensureCustomer({
      userRef: sub.customerUserId,
      // Keyed on the user, not the subscription: one processor customer per
      // person, holding whatever cards they have added, rather than a fresh
      // one for every service they subscribe to.
      idempotencyKey: `customer:${sub.customerUserId}`,
    })
    if (!created.ok) {
      return { ok: false, code: 'PROCESSOR_ERROR', message: created.message }
    }
    customerRef = created.customerRef

    const { error } = await args.db
      .from('subscriptions')
      .update({ stripe_customer_id: customerRef })
      .eq('id', sub.id)
    if (error) {
      console.error('[activation] customer ref write failed', error.message)
      return { ok: false, code: 'WRITE_FAILED', message: 'Could not start payment setup.' }
    }
  }

  const intent = await charger.createSetupIntent({
    customerRef,
    idempotencyKey: `setup:${sub.id}`,
  })
  if (!intent.ok) return { ok: false, code: 'PROCESSOR_ERROR', message: intent.message }

  return { ok: true, clientSecret: intent.clientSecret, customerRef }
}

/**
 * Charges the first cycle and activates.
 *
 * Safe to call again after any failure. Everything that moves money is
 * keyed, and the state change is last.
 */
export async function activateSubscription(args: {
  db: Db
  subscriptionId: string
  actorUserId: string
  input: ActivateInput
  now: Date
  ip?: string | null
}): Promise<ActivationResult> {
  const { db, now } = args

  // --- 1. Load, authorise, gate, re-check capacity -------------------------
  const sub = await load(db, args.subscriptionId)
  if (!sub) return { ok: false, code: 'NOT_FOUND', message: 'No such subscription.' }

  if (sub.customerUserId !== args.actorUserId) {
    return {
      ok: false,
      code: 'NOT_YOUR_SUBSCRIPTION',
      message: 'Only the customer on this subscription can pay for it.',
    }
  }

  const move = canMoveSubscription({ from: sub.state as never, to: 'active', actor: 'system' })
  if (!move.ok) {
    return { ok: false, code: 'NOT_PENDING', message: move.message }
  }

  if (!sub.cycleStart || !sub.cycleEnd) {
    return { ok: false, code: 'NO_CYCLE', message: 'This subscription has no billing cycle set.' }
  }

  const gate = await checkProviderGate({ db, providerUserId: sub.providerUserId, now })
  if (!gate.ok) return gate.failure

  const room = await hasRoom(db, sub)
  if (!room) {
    // A full route is a normal state, not a failure. PRD section 14 makes
    // filling a route before widening it the growth mechanic -- and the
    // customer has not been charged, so nothing needs undoing.
    return {
      ok: false,
      code: 'AT_CAPACITY',
      message: 'This route filled up before your payment went through. Nothing was charged.',
    }
  }

  // --- 2. Price ------------------------------------------------------------
  const quoted = quoteCycle({
    priceCents: sub.priceCents,
    priceUnit: sub.priceUnit,
    billingCycleWeeks: sub.billingCycleWeeks,
    fee: { percentBasisPoints: sub.feeBps, minimumCents: sub.feeMinCents },
  })

  // The number of visits actually scheduled in this cycle must match what
  // the quote bills for. If they have drifted -- a schedule edited between
  // checkout and payment, a generation that fell short -- refusing is the
  // only honest move. Charging for four visits when three are on the
  // calendar is overcharging, however small the gap.
  const scheduled = await countCycleOccurrences(db, sub)
  if (scheduled !== quoted.occurrences) {
    console.error('[activation] cycle occurrence count does not match the quote', {
      subscriptionId: sub.id,
      scheduled,
      quoted: quoted.occurrences,
    })
    return {
      ok: false,
      code: 'QUOTE_MISMATCH',
      message: 'This subscription needs to be set up again. Nothing was charged.',
    }
  }

  const referral = await quoteWithReferral({ db, subscriptionId: sub.id, quote: quoted })
  const quote = referral.quote
  const chargedCents = quote.customerTotalCents

  const idempotencyKey = cycleChargeKey({ subscriptionId: sub.id, cycleStartIso: sub.cycleStart })

  // --- 3. Store the processor references -----------------------------------
  const customerRef = sub.stripeCustomerId
  if (!customerRef) {
    return {
      ok: false,
      code: 'PROCESSOR_ERROR',
      message: 'Payment setup has not been started for this subscription.',
    }
  }

  const { error: refError } = await db
    .from('subscriptions')
    .update({ stripe_payment_method_id: args.input.paymentMethodRef })
    .eq('id', sub.id)
    .eq('state', 'pending')

  if (refError) {
    console.error('[activation] payment method write failed', refError.message)
    return { ok: false, code: 'WRITE_FAILED', message: 'Could not save that payment method.' }
  }

  // --- 4. Charge -----------------------------------------------------------
  let externalId: string | null = null

  if (chargedCents > 0) {
    const charge = await getCharger().charge({
      amountCents: chargedCents,
      currency: 'USD',
      customerRef,
      paymentMethodRef: args.input.paymentMethodRef,
      idempotencyKey,
      description: `Count On Local, ${quote.occurrences} visit(s)`,
    })

    if (!charge.ok) {
      // The subscription stays pending. It is not `payment_failed`: that
      // state means an established subscription's renewal failed, and this
      // one has never been active. Pending is retryable with another card
      // and costs the provider nothing in the meantime.
      await writeAudit({
        actorUserId: args.actorUserId,
        actorRole: 'customer',
        action: 'subscription.payment_failed',
        targetType: 'subscription',
        targetId: sub.id,
        after: { amount_cents: chargedCents, stage: 'activation' },
        reasonCode: charge.code === 'declined' ? 'card_declined' : 'processor_error',
        ip: args.ip ?? null,
      })

      return {
        ok: false,
        code: charge.code === 'declined' ? 'CARD_DECLINED' : 'PROCESSOR_ERROR',
        message: charge.message,
      }
    }

    externalId = charge.externalId
  }

  // --- 5. Ledger -----------------------------------------------------------
  const entries = chargeEntries({
    quote,
    subscriptionId: sub.id,
    customerUserId: sub.customerUserId,
    providerUserId: sub.providerUserId,
    idempotencyKey,
    ...(externalId ? { externalProcessor: 'stripe', externalId } : {}),
  })

  const written = await writeBalancedEntries({ db, entries })
  if (!written.ok) {
    // Money may have moved. Loud, and left for reconciliation -- calling
    // again is safe and is the repair.
    console.error('[activation] ledger write failed after charge', {
      subscriptionId: sub.id,
      externalId,
      code: written.code,
    })
    return { ok: false, code: 'LEDGER_WRITE_FAILED', message: written.message }
  }

  // --- 6. Spend the referral discount --------------------------------------
  if (referral.referralId !== null) {
    const spent = await markDiscountSpent({
      db,
      referralId: referral.referralId,
      discountCents: referral.discountCents,
      now,
    })
    if (!spent) {
      console.warn('[activation] referral discount was already spent', {
        subscriptionId: sub.id,
        referralId: referral.referralId,
      })
    }
  }

  // --- 7. Activate ---------------------------------------------------------
  const { error: activateError } = await db
    .from('subscriptions')
    .update({
      state: 'active',
      started_at: now.toISOString(),
      // The cycle already runs to this date; recording it means a dashboard
      // can say when the next bill lands without re-deriving the window.
      next_charge_at: `${sub.cycleEnd}T00:00:00Z`,
    })
    .eq('id', sub.id)
    .eq('state', 'pending')

  if (activateError) {
    // The charge and the ledger both succeeded. Loud, and recoverable by
    // calling again: the processor returns the original charge and the
    // ledger refuses the duplicate, so the retry only does step 7.
    console.error('[activation] state change failed after a successful charge', {
      subscriptionId: sub.id,
      externalId,
      message: activateError.message,
    })
    return { ok: false, code: 'WRITE_FAILED', message: 'Payment went through but activation failed. Please contact support.' }
  }

  await writeAudit({
    actorUserId: args.actorUserId,
    actorRole: 'customer',
    action: 'subscription.activated',
    targetType: 'subscription',
    targetId: sub.id,
    before: { state: 'pending' },
    after: {
      state: 'active',
      charged_cents: chargedCents,
      referral_discount_cents: referral.discountCents,
      cycle_start: sub.cycleStart,
    },
    ip: args.ip ?? null,
  })

  // A provider gaining a customer is the whole point of the product, and
  // nothing told them. They would have found out from tomorrow's route.
  //
  // After the audit row and after the return value is settled, because a
  // notice must never be the reason an activated subscription reports a
  // failure.
  await noticeToProviderAndGuardian({
    db,
    providerUserId: sub.providerUserId,
    now,
    // The subscription, not the run: re-activating the same one must not
    // announce it twice.
    idempotencyKey: `new_subscriber:${sub.id}`,
    kind: 'subscription.new_subscriber',
    subject: 'You have a new customer',
    // Nothing about who they are or where they live. This says something
    // happened; the route says the rest, behind a sign-in.
    // "On your street" was both a leak-shaped phrase and inaccurate -- a
    // subscriber is anywhere in the service area, not necessarily the same
    // street.
    preview: 'Someone nearby subscribed. Their first visit is on your round.',
    payload: { subscriptionId: sub.id },
  })

  return {
    ok: true,
    state: 'active',
    chargedCents,
    referralDiscountCents: referral.discountCents,
    quote,
    externalId,
  }
}

async function checkProviderGate(args: {
  db: Db
  providerUserId: string
  now: Date
}): Promise<{ ok: true } | { ok: false; failure: ActivationResult }> {
  const { data: roleRows } = await args.db
    .from('user_roles')
    .select('role')
    .eq('user_id', args.providerUserId)

  const ctx = await loadProviderGateContext({
    db: args.db,
    providerUserId: args.providerUserId,
    roles: (roleRows ?? []).map((r) => r.role as Role),
    now: args.now,
  })

  if (!ctx) {
    return {
      ok: false,
      failure: {
        ok: false,
        code: 'PROVIDER_NOT_ELIGIBLE',
        message: 'This service is not taking new customers right now.',
      },
    }
  }

  const decision = canAcceptNewSubscription(ctx)
  if (decision.allowed) return { ok: true }

  return {
    ok: false,
    failure: {
      ok: false,
      code:
        decision.code === 'GUARDIAN_APPROVAL_REQUIRED'
          ? 'GUARDIAN_APPROVAL_REQUIRED'
          : 'PROVIDER_NOT_ELIGIBLE',
      // Deliberately the same sentence either way. A customer does not need
      // to be told that the person mowing their lawn is a minor whose
      // guardian has not signed off -- SAFETY_TRUST_POLICY keeps a
      // provider's age and guardian state out of public surfaces, and an
      // error message shown to a stranger is a public surface.
      message: 'This service is not taking new customers right now.',
    },
  }
}

/**
 * Room on the route, not counting this subscription.
 *
 * The pending row already exists and already counts as live, so comparing
 * the raw total against the maximum would count the customer against their
 * own place. Excluding it makes this exactly the check the preview made
 * before the row existed.
 */
async function hasRoom(db: Db, sub: Loaded): Promise<boolean> {
  if (!Number.isFinite(sub.capacityMax) || sub.capacityMax <= 0) return true

  const { count } = await db
    .from('subscriptions')
    .select('id', { count: 'exact', head: true })
    .eq('provider_service_id', sub.providerServiceId)
    .in('state', ['pending', 'active', 'paused', 'payment_failed'])
    .neq('id', sub.id)

  return (count ?? 0) < sub.capacityMax
}

async function countCycleOccurrences(db: Db, sub: Loaded): Promise<number> {
  const { count } = await db
    .from('service_occurrences')
    .select('id', { count: 'exact', head: true })
    .eq('subscription_id', sub.id)
    .gte('service_date', sub.cycleStart!)
    .lte('service_date', sub.cycleEnd!)
    .not('state', 'in', '("canceled")')

  return count ?? 0
}
