/**
 * Pausing, resuming and cancelling a subscription.
 *
 * PRD section 16: "Cancellation must be self-service. No 'contact support to
 * cancel' dark pattern." So cancel is one authenticated call by the
 * customer, it takes effect immediately, and there is a preview that says
 * what it costs before they commit.
 *
 * ## What each one does
 *
 * pause   -- state stops the next cycle being charged, and the remaining
 *            visits in the cycle already paid for are released under the
 *            normal notice rules. Credit stays on the ledger; a resumed
 *            subscription spends it on its next cycle.
 *
 * resume  -- back to active. Nothing financial happens: the credit is
 *            already there and settlement will find it.
 *
 * cancel  -- same release, then terminal, then whatever credit is left is
 *            refunded, because there is no next cycle to spend it on
 *            (PRD section 12).
 *
 * ## Refund ordering
 *
 * Credits are written before the refund is attempted, and the refund amount
 * is read back from the ledger rather than trusted from the plan. If the
 * refund then fails, the customer holds a credit balance on a cancelled
 * subscription -- visible, owed, and repairable by re-running. The reverse
 * order would refund money the ledger does not know about.
 */

import {
  canMoveSubscription,
  planEnding,
  type EndingPlan,
  type ReleasableOccurrence,
  type SubscriptionState,
} from '@/domain/subscription'
import { creditEntries, standingCreditCents, visitFeeShareCents, type LedgerEntry } from '@/domain/ledger'
import { quoteCycle, type PriceUnit } from '@/domain/money'
import type { SkipPolicy } from '@/domain/credit'
import type { OccurrenceState } from '@/domain/occurrence'
import { writeBalancedEntries } from '@/server/ledgerWriter'
import { parseServiceDate } from '@/server/occurrenceService'
import { civilDateIn } from '@/server/occurrenceJobs'
import { getCharger } from '@/server/charger'
import { writeAudit } from '@/server/audit'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'

type Db = SupabaseClient<Database>

export type SubscriptionFailure =
  | 'NOT_FOUND'
  | 'NOT_YOUR_SUBSCRIPTION'
  | 'ILLEGAL_TRANSITION'
  | 'WRITE_FAILED'

export type EndingResult =
  | {
      ok: true
      state: SubscriptionState
      plan: EndingPlan
      refundedCents: number
      /** True when a refund was owed but could not be sent. */
      refundPending: boolean
    }
  | { ok: false; code: SubscriptionFailure; message: string }

type Loaded = {
  id: string
  state: SubscriptionState
  customerUserId: string
  providerUserId: string
  timezone: string
  pricing: {
    priceCents: number
    priceUnit: PriceUnit
    billingCycleWeeks: number
    feeBps: number
    feeMinCents: number
  }
}

async function load(db: Db, subscriptionId: string): Promise<Loaded | null> {
  const { data, error } = await db
    .from('subscriptions')
    .select(
      `id, state, customer_user_id, provider_price_cents, price_unit,
       billing_cycle_weeks, platform_fee_bps, platform_fee_min_cents,
       provider_services!inner (
         schedule_rule,
         businesses!inner ( provider_user_id )
       )`,
    )
    .eq('id', subscriptionId)
    .maybeSingle()

  if (error || !data) return null

  const one = <T,>(v: unknown): T | undefined =>
    (Array.isArray(v) ? v[0] : v) as T | undefined

  const svc = one<{ schedule_rule: Record<string, unknown> | null; businesses: unknown }>(
    data.provider_services,
  )
  const biz = one<{ provider_user_id: string }>(svc?.businesses)
  if (!biz) return null

  const tz = svc?.schedule_rule?.['timezone']

  return {
    id: data.id,
    state: data.state as SubscriptionState,
    customerUserId: data.customer_user_id,
    providerUserId: biz.provider_user_id,
    timezone: typeof tz === 'string' ? tz : 'UTC',
    pricing: {
      priceCents: data.provider_price_cents,
      priceUnit: data.price_unit as PriceUnit,
      billingCycleWeeks: data.billing_cycle_weeks,
      feeBps: data.platform_fee_bps,
      feeMinCents: data.platform_fee_min_cents,
    },
  }
}

/** Ledger rows for a subscription, in the domain's shape. */
async function ledgerFor(db: Db, subscriptionId: string): Promise<LedgerEntry[]> {
  const { data } = await db
    .from('ledger_entries')
    .select('kind, amount_cents')
    .eq('subscription_id', subscriptionId)
  return (data ?? []).map((r) => ({
    kind: r.kind,
    amountCents: r.amount_cents,
    currency: 'USD',
  })) as LedgerEntry[]
}

async function releasableOccurrences(
  db: Db,
  sub: Loaded,
): Promise<{ occurrences: ReleasableOccurrence[]; feeShare: number }> {
  const cycleQuote = quoteCycle({
    priceCents: sub.pricing.priceCents,
    priceUnit: sub.pricing.priceUnit,
    billingCycleWeeks: sub.pricing.billingCycleWeeks,
    fee: { percentBasisPoints: sub.pricing.feeBps, minimumCents: sub.pricing.feeMinCents },
  })

  const { data } = await db
    .from('service_occurrences')
    .select('id, state, service_date, service_value_cents')
    .eq('subscription_id', sub.id)

  const occurrences: ReleasableOccurrence[] = (data ?? []).map((o) => ({
    id: o.id,
    state: o.state as OccurrenceState,
    serviceDate: parseServiceDate(o.service_date),
    valueCents: o.service_value_cents,
    feeShareCents: visitFeeShareCents({
      cycleFeeCents: cycleQuote.platformFeeCents,
      visitValueCents: o.service_value_cents,
      cycleSubtotalCents: cycleQuote.serviceSubtotalCents,
    }),
  }))

  const feeShare = visitFeeShareCents({
    cycleFeeCents: cycleQuote.platformFeeCents,
    visitValueCents: sub.pricing.priceCents,
    cycleSubtotalCents: cycleQuote.serviceSubtotalCents,
  })

  return { occurrences, feeShare }
}

/**
 * What pausing or cancelling would do, without doing it.
 *
 * PRD section 21 requires the customer be shown the money consequence
 * before confirming. Shares its planning with the real thing so the two
 * cannot disagree.
 */
export async function previewEnding(args: {
  db: Db
  subscriptionId: string
  actorUserId: string
  now: Date
  ending: 'pause' | 'cancel'
  policy?: SkipPolicy | undefined
}): Promise<{ ok: true; plan: EndingPlan } | { ok: false; code: SubscriptionFailure; message: string }> {
  const sub = await load(args.db, args.subscriptionId)
  if (!sub) return { ok: false, code: 'NOT_FOUND', message: 'No such subscription.' }
  if (sub.customerUserId !== args.actorUserId) {
    return {
      ok: false,
      code: 'NOT_YOUR_SUBSCRIPTION',
      message: 'Only the customer on this subscription can change it.',
    }
  }

  const { occurrences } = await releasableOccurrences(args.db, sub)
  const ledger = await ledgerFor(args.db, sub.id)

  return {
    ok: true,
    plan: planEnding({
      occurrences,
      today: civilDateIn(sub.timezone, args.now),
      standingCreditCents: standingCreditCents(ledger),
      ending: args.ending,
      ...(args.policy ? { policy: args.policy } : {}),
    }),
  }
}

async function endSubscription(args: {
  db: Db
  subscriptionId: string
  actorUserId: string
  now: Date
  ending: 'pause' | 'cancel'
  policy?: SkipPolicy | undefined
  ip?: string | null
}): Promise<EndingResult> {
  const { db, now, ending } = args

  const sub = await load(db, args.subscriptionId)
  if (!sub) return { ok: false, code: 'NOT_FOUND', message: 'No such subscription.' }
  if (sub.customerUserId !== args.actorUserId) {
    return {
      ok: false,
      code: 'NOT_YOUR_SUBSCRIPTION',
      message: 'Only the customer on this subscription can change it.',
    }
  }

  const target: SubscriptionState = ending === 'pause' ? 'paused' : 'canceled'
  const move = canMoveSubscription({ from: sub.state, to: target, actor: 'customer' })
  if (!move.ok) return { ok: false, code: 'ILLEGAL_TRANSITION', message: move.message }

  const today = civilDateIn(sub.timezone, now)
  const { occurrences } = await releasableOccurrences(db, sub)
  const before = await ledgerFor(db, sub.id)

  const plan = planEnding({
    occurrences,
    today,
    standingCreditCents: standingCreditCents(before),
    ending,
    ...(args.policy ? { policy: args.policy } : {}),
  })

  // --- Release the remaining visits -------------------------------------
  for (const release of plan.released) {
    const occ = occurrences.find((o) => o.id === release.occurrenceId)!
    const nextState = release.credit.credited ? 'credited' : 'canceled'

    await db
      .from('service_occurrences')
      .update({ state: nextState })
      .eq('id', occ.id)
      .in('state', ['scheduled', 'due_today'])

    if (release.credit.credited && release.credit.amountCents > 0) {
      await writeBalancedEntries({
        db,
        entries: creditEntries({
          serviceCents: release.credit.amountCents,
          feeShareCents: occ.feeShareCents,
          subscriptionId: sub.id,
          occurrenceId: occ.id,
          customerUserId: sub.customerUserId,
          providerUserId: sub.providerUserId,
          memo: `${ending}:${release.credit.code}`,
          idempotencyKey: `credit:${occ.id}`,
        }),
      })
    }
  }

  // --- Move the subscription --------------------------------------------
  const { error: stateError } = await db
    .from('subscriptions')
    .update({
      state: target,
      ...(ending === 'cancel' ? { canceled_at: now.toISOString() } : {}),
    })
    .eq('id', sub.id)
    .eq('state', sub.state)

  if (stateError) {
    console.error('[subscription] state write failed', stateError.message)
    return { ok: false, code: 'WRITE_FAILED', message: 'Could not save that. Try again.' }
  }

  // --- Refund what is left, on a cancellation ---------------------------
  let refundedCents = 0
  let refundPending = false

  if (ending === 'cancel') {
    // Read the amount back from the ledger rather than trusting the plan:
    // the credits above have now been written, and the ledger is the record.
    const owed = standingCreditCents(await ledgerFor(db, sub.id))

    if (owed > 0) {
      const charge = await lastChargeFor(db, sub.id)

      if (!charge) {
        // Nothing was ever charged, so there is nothing to refund against.
        // The credit stays on the ledger for support to resolve.
        refundPending = true
        console.warn('[subscription] credit owed with no charge to refund against', {
          subscriptionId: sub.id,
          owed,
        })
      } else {
        const result = await getCharger().refund({
          amountCents: owed,
          externalChargeId: charge,
          idempotencyKey: `refund:${sub.id}`,
          reason: 'subscription_canceled',
        })

        if (result.ok) {
          // Two entries, netting to zero, because a refund does two things.
          //
          //   adjustment +owed   the standing credit is consumed
          //   refund     -owed   cash leaves the platform
          //
          // A single positive refund row would discharge the credit and
          // also make the subscription's ledger sum positive, as if the
          // platform had gained the money it just paid out. A single
          // negative row would move the cash but leave the credit standing,
          // so the customer would appear owed it twice.
          await writeBalancedEntries({
            db,
            entries: [
              {
                kind: 'adjustment',
                amountCents: owed,
                currency: 'USD',
                subscriptionId: sub.id,
                customerUserId: sub.customerUserId,
                providerUserId: sub.providerUserId,
                idempotencyKey: `refund-credit:${sub.id}`,
                memo: 'Credit settled by refund',
              },
              {
                kind: 'refund',
                amountCents: -owed,
                currency: 'USD',
                subscriptionId: sub.id,
                customerUserId: sub.customerUserId,
                providerUserId: sub.providerUserId,
                externalProcessor: result.processor,
                externalId: result.externalId,
                idempotencyKey: `refund:${sub.id}`,
                memo: 'Refund of unspent credit on cancellation',
              },
            ],
          })
          refundedCents = owed
        } else {
          // Money did not move. The credit is still on the ledger, so the
          // customer is still owed it and a retry can send it.
          refundPending = true
          console.error('[subscription] refund failed', {
            subscriptionId: sub.id,
            owed,
            message: result.message,
          })
        }
      }
    }
  }

  await writeAudit({
    actorUserId: args.actorUserId,
    actorRole: 'customer',
    action: ending === 'pause' ? 'subscription.paused' : 'subscription.canceled',
    targetType: 'subscription',
    targetId: sub.id,
    before: { state: sub.state },
    after: {
      state: target,
      released: plan.released.length,
      credited: plan.released.filter((r) => r.credit.credited).length,
      refunded_cents: refundedCents,
      refund_pending: refundPending,
    },
    ip: args.ip ?? null,
  })

  return { ok: true, state: target, plan, refundedCents, refundPending }
}

/** The processor id of the most recent charge, to refund against. */
async function lastChargeFor(db: Db, subscriptionId: string): Promise<string | null> {
  const { data } = await db
    .from('ledger_entries')
    .select('external_id, created_at')
    .eq('subscription_id', subscriptionId)
    .eq('kind', 'customer_charge')
    .not('external_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data?.external_id ?? null
}

export function pauseSubscription(args: {
  db: Db
  subscriptionId: string
  actorUserId: string
  now: Date
  policy?: SkipPolicy | undefined
  ip?: string | null
}): Promise<EndingResult> {
  return endSubscription({ ...args, ending: 'pause' })
}

export function cancelSubscription(args: {
  db: Db
  subscriptionId: string
  actorUserId: string
  now: Date
  policy?: SkipPolicy | undefined
  ip?: string | null
}): Promise<EndingResult> {
  return endSubscription({ ...args, ending: 'cancel' })
}

export type ResumeResult =
  | { ok: true; state: 'active' }
  | { ok: false; code: SubscriptionFailure; message: string }

/**
 * Back to active.
 *
 * Nothing financial happens here. Any credit is already on the ledger and
 * the next settlement finds it; the horizon job regenerates the visits that
 * were released. Re-crediting or re-creating them here would double up.
 */
export async function resumeSubscription(args: {
  db: Db
  subscriptionId: string
  actorUserId: string
  ip?: string | null
}): Promise<ResumeResult> {
  const sub = await load(args.db, args.subscriptionId)
  if (!sub) return { ok: false, code: 'NOT_FOUND', message: 'No such subscription.' }
  if (sub.customerUserId !== args.actorUserId) {
    return {
      ok: false,
      code: 'NOT_YOUR_SUBSCRIPTION',
      message: 'Only the customer on this subscription can change it.',
    }
  }

  const move = canMoveSubscription({ from: sub.state, to: 'active', actor: 'customer' })
  if (!move.ok) return { ok: false, code: 'ILLEGAL_TRANSITION', message: move.message }

  const { error } = await args.db
    .from('subscriptions')
    .update({ state: 'active' })
    .eq('id', sub.id)
    .eq('state', sub.state)

  if (error) {
    console.error('[subscription] resume failed', error.message)
    return { ok: false, code: 'WRITE_FAILED', message: 'Could not save that. Try again.' }
  }

  await writeAudit({
    actorUserId: args.actorUserId,
    actorRole: 'customer',
    action: 'subscription.resumed',
    targetType: 'subscription',
    targetId: sub.id,
    before: { state: sub.state },
    after: { state: 'active' },
    ip: args.ip ?? null,
  })

  return { ok: true, state: 'active' }
}
