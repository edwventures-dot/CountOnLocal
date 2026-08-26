/**
 * Running settlement.
 *
 * Closes the cycle that ended, charges the one starting, and writes the
 * ledger. The decision of what to do is domain/settlement.ts; this does it,
 * in an order chosen so that every way it can fail leaves something
 * recoverable rather than something wrong.
 *
 * ## Order of operations, and why
 *
 * 1. Plan. Pure, no writes.
 * 2. Charge the card, with a key derived from (subscription, cycle start).
 * 3. Write the ledger.
 * 4. Settle the closing occurrences and advance the cycle window.
 *
 * Charging before writing means a crash between 2 and 3 leaves money taken
 * with no ledger row -- visible, and repairable from the processor's own
 * records. The alternative, writing first, leaves a ledger claiming money
 * that was never taken, which is worse: the books look right and the
 * provider is owed against a payment that does not exist.
 *
 * Advancing the cycle last means a crash before 4 causes the next run to
 * try the same cycle again. That is safe precisely because of the
 * idempotency key: the processor returns the original charge rather than
 * making a second one, and the unique index on the ledger key refuses the
 * duplicate row. Re-running is the recovery path, not a hazard.
 *
 * ## What is deliberately not done here
 *
 * Nothing decides an unresolved occurrence. A visit still sitting in
 * due_today when its cycle closes is reported and left. Paying a provider
 * for work with no evidence, or crediting a customer for work that may well
 * have happened, are both worse than a row somebody has to look at.
 */

import {
  planSettlement,
  cycleIsDue,
  type SettlementPlan,
  type CycleOccurrence,
} from '@/domain/settlement'
import {
  chargeEntries,
  cycleChargeKey,
  standingCreditCents,
  type LedgerEntry,
} from '@/domain/ledger'
import type { OccurrenceState } from '@/domain/occurrence'
import type { PriceUnit } from '@/domain/money'
import { isoDate } from '@/domain/schedule'
import { civilDateIn } from '@/server/occurrenceJobs'
import { parseServiceDate } from '@/server/occurrenceService'
import { writeBalancedEntries } from '@/server/ledgerWriter'
import { getCharger } from '@/server/charger'
import { markDiscountSpent, quoteWithReferral } from '@/server/referralService'
import { writeAudit } from '@/server/audit'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'

type Db = SupabaseClient<Database>

export type SettleOutcome =
  | { ok: true; status: 'settled'; plan: SettlementPlan; externalId: string | null }
  | { ok: true; status: 'not_due' }
  | { ok: true; status: 'nothing_to_do'; reason: string }
  | {
      ok: false
      status: 'declined' | 'error'
      code: string
      message: string
      plan?: SettlementPlan
    }

type SubscriptionRow = {
  id: string
  customer_user_id: string
  state: string
  provider_price_cents: number
  price_unit: string
  billing_cycle_weeks: number
  platform_fee_bps: number
  platform_fee_min_cents: number
  current_cycle_start: string | null
  current_cycle_end: string | null
  stripe_customer_id: string | null
  stripe_payment_method_id: string | null
}

/** Settles one subscription. Safe to call again after any failure. */
export async function settleSubscription(args: {
  db: Db
  subscriptionId: string
  now: Date
  /** Overrides the service time zone when resolving "today". Tests only. */
  timezone?: string
}): Promise<SettleOutcome> {
  const { db, subscriptionId, now } = args

  const { data: sub, error } = await db
    .from('subscriptions')
    .select(
      `id, customer_user_id, state, provider_price_cents, price_unit,
       billing_cycle_weeks, platform_fee_bps, platform_fee_min_cents,
       current_cycle_start, current_cycle_end,
       stripe_customer_id, stripe_payment_method_id,
       provider_services!inner (
         schedule_rule,
         businesses!inner ( provider_user_id )
       )`,
    )
    .eq('id', subscriptionId)
    .maybeSingle()

  if (error || !sub) {
    return { ok: false, status: 'error', code: 'NOT_FOUND', message: 'No such subscription.' }
  }

  const row = sub as unknown as SubscriptionRow & { provider_services: unknown }

  if (row.state !== 'active') {
    return { ok: true, status: 'nothing_to_do', reason: `subscription is ${row.state}` }
  }
  if (!row.current_cycle_end) {
    return { ok: true, status: 'nothing_to_do', reason: 'no cycle window set' }
  }

  const svc = (Array.isArray(row.provider_services) ? row.provider_services[0] : row.provider_services) as
    | { schedule_rule: Record<string, unknown> | null; businesses: unknown }
    | undefined
  const biz = (Array.isArray(svc?.businesses) ? svc?.businesses[0] : svc?.businesses) as
    | { provider_user_id: string }
    | undefined
  if (!biz) {
    return { ok: false, status: 'error', code: 'NO_PROVIDER', message: 'Subscription has no provider.' }
  }
  const providerUserId = biz.provider_user_id

  const timezone =
    args.timezone ?? (typeof svc?.schedule_rule?.['timezone'] === 'string'
      ? (svc.schedule_rule['timezone'] as string)
      : 'UTC')

  const cycleEnd = parseServiceDate(row.current_cycle_end)
  const today = civilDateIn(timezone, now)

  if (!cycleIsDue({ cycleEnd, today })) return { ok: true, status: 'not_due' }

  // Occurrences belonging to the closing cycle.
  const from = row.current_cycle_start ?? row.current_cycle_end
  const { data: occRows } = await db
    .from('service_occurrences')
    .select('id, state, service_date')
    .eq('subscription_id', row.id)
    .gte('service_date', from)
    .lte('service_date', row.current_cycle_end)

  const closingOccurrences: CycleOccurrence[] = (occRows ?? []).map((o) => ({
    id: o.id,
    state: o.state as OccurrenceState,
    serviceDate: parseServiceDate(o.service_date),
  }))

  // Standing credit comes from the ledger, not from counting skips: a
  // credit that failed to write must not be silently re-granted.
  const { data: ledgerRows } = await db
    .from('ledger_entries')
    .select('kind, amount_cents')
    .eq('subscription_id', row.id)

  const standing = standingCreditCents(
    (ledgerRows ?? []).map((r) => ({
      kind: r.kind,
      amountCents: r.amount_cents,
      currency: 'USD',
    })) as LedgerEntry[],
  )

  const plan = planSettlement({
    closingOccurrences,
    cycleEnd,
    billingCycleWeeks: row.billing_cycle_weeks,
    priceCents: row.provider_price_cents,
    priceUnit: row.price_unit as PriceUnit,
    fee: {
      percentBasisPoints: row.platform_fee_bps,
      minimumCents: row.platform_fee_min_cents,
    },
    standingCreditCents: standing,
  })

  const idempotencyKey = cycleChargeKey({
    subscriptionId: row.id,
    cycleStartIso: isoDate(plan.nextCycleStart),
  })

  // --- 1b. Referral discount ----------------------------------------------
  //
  // Applied to the first charge this subscription ever receives, whichever
  // path makes it. `quoteWithReferral` returns the quote unchanged when
  // there is nothing unspent, so the rest of settlement does not branch.
  //
  // Nothing is marked spent yet. A discount recorded against a charge that
  // then declines would quietly cost the customer their reward, and the
  // re-run would find nothing left to apply.
  //
  // Held back on a cycle that cannot absorb it. A cycle already covered by
  // standing credit charges nothing, and spending a first-cycle reward on a
  // charge of zero would give the customer nothing while marking the reward
  // used. It also keeps chargeEntries' own guard satisfied: credit can
  // never exceed a customer total this has shrunk.
  const referral =
    plan.amountToChargeCents > 0
      ? await quoteWithReferral({ db, subscriptionId: row.id, quote: plan.quote })
      : { quote: plan.quote, discountCents: 0 as const, referralId: null }

  const affordable = referral.referralId !== null && referral.discountCents <= plan.amountToChargeCents
  const quote = affordable ? referral.quote : plan.quote
  const discountCents = affordable ? referral.discountCents : 0
  const amountToChargeCents = plan.amountToChargeCents - discountCents

  // --- 2. Charge -----------------------------------------------------------
  let externalId: string | null = null

  if (amountToChargeCents > 0) {
    if (!row.stripe_customer_id || !row.stripe_payment_method_id) {
      return {
        ok: false,
        status: 'error',
        code: 'NO_PAYMENT_METHOD',
        message: 'Subscription has no payment method on file.',
        plan,
      }
    }

    const charge = await getCharger().charge({
      amountCents: amountToChargeCents,
      currency: 'USD',
      customerRef: row.stripe_customer_id,
      paymentMethodRef: row.stripe_payment_method_id,
      idempotencyKey,
      description: `Count On Local, ${plan.quote.occurrences} visit(s)`,
    })

    if (!charge.ok) {
      if (charge.code === 'declined') {
        await db.from('subscriptions').update({ state: 'payment_failed' }).eq('id', row.id)
        await writeAudit({
          actorUserId: null,
          actorRole: 'system',
          action: 'subscription.payment_failed',
          targetType: 'subscription',
          targetId: row.id,
          after: { amount_cents: amountToChargeCents },
          reasonCode: 'card_declined',
        })
      }
      return {
        ok: false,
        status: charge.code,
        code: charge.code === 'declined' ? 'CARD_DECLINED' : 'PROCESSOR_ERROR',
        message: charge.message,
        plan,
      }
    }

    externalId = charge.externalId
  }

  // --- 3. Ledger -----------------------------------------------------------
  const entries = chargeEntries({
    quote,
    subscriptionId: row.id,
    customerUserId: row.customer_user_id,
    providerUserId,
    idempotencyKey,
    creditAppliedCents: plan.creditAppliedCents,
    ...(externalId ? { externalProcessor: 'stripe', externalId } : {}),
  })

  const written = await writeBalancedEntries({ db, entries })
  if (!written.ok) {
    // Money may have moved. Loud, and left for reconciliation -- re-running
    // is safe and is the repair.
    console.error('[settlement] ledger write failed after charge', {
      subscriptionId: row.id,
      externalId,
      code: written.code,
    })
    return {
      ok: false,
      status: 'error',
      code: 'LEDGER_WRITE_FAILED',
      message: written.message,
      plan,
    }
  }

  // --- 3b. Spend the referral discount -------------------------------------
  //
  // After the charge and after the ledger, because both can fail and this
  // is the only record that the reward was used. The update is conditional
  // on it still being unspent, so a re-run of the same cycle -- which the
  // idempotency key makes safe everywhere else -- cannot discount twice.
  if (affordable && referral.referralId !== null) {
    const spent = await markDiscountSpent({
      db,
      referralId: referral.referralId,
      discountCents,
      now,
    })
    if (!spent) {
      // Somebody else claimed it between the read and here. The charge
      // already went out at the discounted price, so the platform gave up
      // the fee twice for one referral. Small, bounded, and worth seeing.
      console.warn('[settlement] referral discount was already spent', {
        subscriptionId: row.id,
        referralId: referral.referralId,
      })
    }
  }

  // --- 4. Advance ----------------------------------------------------------
  if (plan.toSettle.length > 0) {
    await db
      .from('service_occurrences')
      .update({ state: 'settled' })
      .in('id', plan.toSettle)
      .eq('state', 'completed')
  }

  await db
    .from('subscriptions')
    .update({
      current_cycle_start: isoDate(plan.nextCycleStart),
      current_cycle_end: isoDate(plan.nextCycleEnd),
    })
    .eq('id', row.id)

  await writeAudit({
    actorUserId: null,
    actorRole: 'system',
    action: 'subscription.cycle_settled',
    targetType: 'subscription',
    targetId: row.id,
    after: {
      cycle_start: isoDate(plan.nextCycleStart),
      charged_cents: amountToChargeCents,
      credit_applied_cents: plan.creditAppliedCents,
      referral_discount_cents: discountCents,
      settled: plan.toSettle.length,
      unresolved: plan.unresolved.length,
    },
  })

  if (plan.unresolved.length > 0) {
    // Not an error, but somebody should look. The provider never said
    // whether these happened.
    console.warn('[settlement] cycle closed with unresolved occurrences', {
      subscriptionId: row.id,
      count: plan.unresolved.length,
    })
  }

  return { ok: true, status: 'settled', plan, externalId }
}

export type SettleRunResult = {
  considered: number
  settled: number
  notDue: number
  failed: Array<{ subscriptionId: string; code: string; message: string }>
}

/** Settles every active subscription whose cycle has ended. */
export async function runSettlement(args: { db: Db; now: Date }): Promise<SettleRunResult> {
  const result: SettleRunResult = { considered: 0, settled: 0, notDue: 0, failed: [] }

  const { data: subs, error } = await args.db
    .from('subscriptions')
    .select('id')
    .eq('state', 'active')

  if (error) {
    result.failed.push({ subscriptionId: '*', code: 'QUERY_FAILED', message: error.message })
    return result
  }

  for (const sub of subs ?? []) {
    result.considered++
    const outcome = await settleSubscription({
      db: args.db,
      subscriptionId: sub.id,
      now: args.now,
    })

    if (!outcome.ok) {
      result.failed.push({ subscriptionId: sub.id, code: outcome.code, message: outcome.message })
    } else if (outcome.status === 'settled') {
      result.settled++
    } else if (outcome.status === 'not_due') {
      result.notDue++
    }
  }

  return result
}
