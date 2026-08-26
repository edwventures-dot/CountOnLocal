/**
 * Completing and skipping service occurrences.
 *
 * Every state change here goes through domain/occurrence.canTransition, so
 * an illegal edge is unreachable even if a handler is called out of order --
 * the same arrangement guardianService has with the guardian state machine.
 * The row is written only after the transition says yes.
 *
 * Authorisation is checked here rather than trusted from the caller. The
 * route handler knows who is signed in; this function knows whether that
 * person is the provider who owns the business or the customer who owns the
 * subscription, and refuses anyone else. CLAUDE.md rule 7: authorisation is
 * server-side, and hiding a button is not authorisation.
 */

import { z } from 'zod'
import {
  canTransition,
  type Actor,
  type OccurrenceState,
} from '@/domain/occurrence'
import {
  decideSkipCredit,
  previewCustomerSkip,
  DEFAULT_SKIP_POLICY,
  type CreditDecision,
  type SkipPolicy,
} from '@/domain/credit'
import { creditEntries, visitFeeShareCents } from '@/domain/ledger'
import { quoteCycle, type PriceUnit } from '@/domain/money'
import { writeBalancedEntries } from '@/server/ledgerWriter'
import { writeAudit } from '@/server/audit'
import type { PlainDate } from '@/domain/age'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'

type Db = SupabaseClient<Database>

/** "2026-09-01" -> PlainDate. The column is a DATE, so there is no time part. */
export function parseServiceDate(iso: string): PlainDate {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) throw new RangeError(`Not an ISO calendar date: ${iso}`)
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }
}

export const completeSchema = z.object({
  occurrenceId: z.string().uuid(),
  note: z.string().max(500).optional(),
})

export const skipSchema = z.object({
  occurrenceId: z.string().uuid(),
  reason: z.string().max(200).optional(),
})

export type OccurrenceFailure =
  | 'NOT_FOUND'
  | 'NOT_YOUR_OCCURRENCE'
  | 'ILLEGAL_TRANSITION'
  | 'WRITE_FAILED'

export type CompleteResult =
  | { ok: true; state: OccurrenceState }
  | { ok: false; code: OccurrenceFailure; message: string }

export type SkipResult =
  | { ok: true; state: OccurrenceState; credit: CreditDecision }
  | { ok: false; code: OccurrenceFailure; message: string }

/**
 * The occurrence plus the two identities allowed to touch it.
 *
 * One query rather than three: the provider is reachable only through
 * subscription -> provider_service -> business, and doing that as separate
 * round trips would leave a window where the subscription is re-pointed
 * between the check and the write.
 */
type Loaded = {
  id: string
  state: OccurrenceState
  serviceDate: string
  serviceValueCents: number
  subscriptionId: string
  customerUserId: string
  providerUserId: string
  /** Frozen on the subscription at checkout, so an old visit keeps old terms. */
  pricing: {
    priceCents: number
    priceUnit: PriceUnit
    billingCycleWeeks: number
    feeBps: number
    feeMinCents: number
  }
}

async function load(db: Db, occurrenceId: string): Promise<Loaded | null> {
  const { data, error } = await db
    .from('service_occurrences')
    .select(
      `id, state, service_date, service_value_cents, subscription_id,
       subscriptions!inner (
         customer_user_id,
         provider_price_cents, price_unit, billing_cycle_weeks,
         platform_fee_bps, platform_fee_min_cents,
         provider_services!inner (
           businesses!inner ( provider_user_id )
         )
       )`,
    )
    .eq('id', occurrenceId)
    .maybeSingle()

  if (error || !data) return null

  // The nested selects come back as objects or single-element arrays
  // depending on how PostgREST infers the relationship; normalise both.
  const sub = (Array.isArray(data.subscriptions) ? data.subscriptions[0] : data.subscriptions) as
    | {
        customer_user_id: string
        provider_price_cents: number
        price_unit: string
        billing_cycle_weeks: number
        platform_fee_bps: number
        platform_fee_min_cents: number
        provider_services: unknown
      }
    | undefined
  if (!sub) return null

  const svc = (Array.isArray(sub.provider_services) ? sub.provider_services[0] : sub.provider_services) as
    | { businesses: unknown }
    | undefined
  const biz = (Array.isArray(svc?.businesses) ? svc?.businesses[0] : svc?.businesses) as
    | { provider_user_id: string }
    | undefined
  if (!biz) return null

  return {
    id: data.id,
    state: data.state as OccurrenceState,
    serviceDate: data.service_date,
    serviceValueCents: data.service_value_cents,
    subscriptionId: data.subscription_id,
    customerUserId: sub.customer_user_id,
    providerUserId: biz.provider_user_id,
    pricing: {
      priceCents: sub.provider_price_cents,
      priceUnit: sub.price_unit as PriceUnit,
      billingCycleWeeks: sub.billing_cycle_weeks,
      feeBps: sub.platform_fee_bps,
      feeMinCents: sub.platform_fee_min_cents,
    },
  }
}

/**
 * Provider marks a stop done.
 *
 * No money moves here. The earning is recognised at cycle settlement, not
 * per stop, because the charge is per cycle -- crediting a provider on each
 * completion would put an earning on the ledger before the matching charge
 * exists and break the per-subscription zero.
 */
export async function completeOccurrence(args: {
  db: Db
  occurrenceId: string
  actorUserId: string
  note?: string | undefined
  ip?: string | null
}): Promise<CompleteResult> {
  const { db, occurrenceId, actorUserId } = args

  const occ = await load(db, occurrenceId)
  if (!occ) return { ok: false, code: 'NOT_FOUND', message: 'No such occurrence.' }

  if (occ.providerUserId !== actorUserId) {
    return {
      ok: false,
      code: 'NOT_YOUR_OCCURRENCE',
      message: 'Only the provider running this route can complete a stop.',
    }
  }

  const move = canTransition({ from: occ.state, to: 'completed', actor: 'provider' })
  if (!move.ok) return { ok: false, code: 'ILLEGAL_TRANSITION', message: move.message }

  const { error } = await db
    .from('service_occurrences')
    .update({
      state: 'completed',
      completed_at: new Date().toISOString(),
      completion_note: args.note ?? null,
    })
    .eq('id', occurrenceId)
    // Optimistic guard: if another request moved the row since we read it,
    // this matches nothing and we do not clobber the newer state.
    .eq('state', occ.state)

  if (error) {
    console.error('[occurrence] complete failed', error.message)
    return { ok: false, code: 'WRITE_FAILED', message: 'Could not save that. Try again.' }
  }

  await writeAudit({
    actorUserId,
    actorRole: 'provider',
    action: 'occurrence.completed',
    targetType: 'service_occurrence',
    targetId: occurrenceId,
    before: { state: occ.state },
    after: { state: 'completed' },
    ip: args.ip ?? null,
  })

  return { ok: true, state: 'completed' }
}

/**
 * Skip a visit.
 *
 * `actor` decides both which transition is attempted and who pays: a
 * provider skip is always credited, a customer skip only outside the notice
 * cutoff. See domain/credit.ts for why those differ.
 *
 * `today` is passed in rather than read from the clock so the caller -- and
 * the tests -- control the civil date the notice window is judged against.
 */
export async function skipOccurrence(args: {
  db: Db
  occurrenceId: string
  actor: Extract<Actor, 'provider' | 'customer'>
  actorUserId: string
  today: PlainDate
  policy?: SkipPolicy | undefined
  reason?: string | undefined
  ip?: string | null
}): Promise<SkipResult> {
  const { db, occurrenceId, actor, actorUserId, today } = args

  const occ = await load(db, occurrenceId)
  if (!occ) return { ok: false, code: 'NOT_FOUND', message: 'No such occurrence.' }

  const owner = actor === 'provider' ? occ.providerUserId : occ.customerUserId
  if (owner !== actorUserId) {
    return {
      ok: false,
      code: 'NOT_YOUR_OCCURRENCE',
      message:
        actor === 'provider'
          ? 'Only the provider running this route can skip a stop.'
          : 'Only the customer on this subscription can skip a visit.',
    }
  }

  const target: OccurrenceState = actor === 'provider' ? 'provider_skipped' : 'customer_skipped'
  const move = canTransition({ from: occ.state, to: target, actor })
  if (!move.ok) return { ok: false, code: 'ILLEGAL_TRANSITION', message: move.message }

  const credit = decideSkipCredit({
    reason: actor === 'provider' ? 'provider_unavailable' : 'customer_requested',
    occurrenceValueCents: occ.serviceValueCents,
    serviceDate: parseServiceDate(occ.serviceDate),
    requestedOn: today,
    policy: args.policy ?? DEFAULT_SKIP_POLICY,
  })

  // A credited skip lands in 'credited', not in the skipped state: the
  // skipped states are a waypoint, and leaving a credited occurrence sitting
  // in one would make "which skips still owe a credit" unanswerable.
  const finalState: OccurrenceState = credit.credited ? 'credited' : target

  const { error } = await db
    .from('service_occurrences')
    .update({ state: finalState })
    .eq('id', occurrenceId)
    .eq('state', occ.state)

  if (error) {
    console.error('[occurrence] skip failed', error.message)
    return { ok: false, code: 'WRITE_FAILED', message: 'Could not save that. Try again.' }
  }

  if (credit.credited && credit.amountCents > 0) {
    const cycleQuote = quoteCycle({
      priceCents: occ.pricing.priceCents,
      priceUnit: occ.pricing.priceUnit,
      billingCycleWeeks: occ.pricing.billingCycleWeeks,
      fee: { percentBasisPoints: occ.pricing.feeBps, minimumCents: occ.pricing.feeMinCents },
    })

    const written = await writeBalancedEntries({
      db,
      entries: creditEntries({
        serviceCents: credit.amountCents,
        // The customer paid a fee on this visit too, so it comes back with
        // it. Proportional to the cycle's actual fee rather than a fresh
        // percentage, so a cycle where the minimum applied reverses the
        // minimum proportionally as well.
        feeShareCents: visitFeeShareCents({
          cycleFeeCents: cycleQuote.platformFeeCents,
          visitValueCents: credit.amountCents,
          cycleSubtotalCents: cycleQuote.serviceSubtotalCents,
        }),
        subscriptionId: occ.subscriptionId,
        occurrenceId: occ.id,
        customerUserId: occ.customerUserId,
        providerUserId: occ.providerUserId,
        memo: credit.code,
        // One credit per occurrence, ever. A double-tapped skip button
        // cannot credit the same visit twice.
        idempotencyKey: `credit:${occ.id}`,
      }),
    })

    if (!written.ok) {
      // The occurrence is already credited but the ledger row is missing.
      // Loud, and left for reconciliation rather than rolled back: the
      // customer has been told they will not be billed, and taking that
      // back silently would be worse than an accounting gap we can see.
      console.error('[occurrence] credit ledger write failed', {
        occurrenceId,
        code: written.code,
      })
    }
  }

  await writeAudit({
    actorUserId,
    actorRole: actor,
    action: actor === 'provider' ? 'occurrence.provider_skipped' : 'occurrence.customer_skipped',
    targetType: 'service_occurrence',
    targetId: occurrenceId,
    before: { state: occ.state },
    after: { state: finalState, credited: credit.credited, credit_cents: credit.amountCents },
    reasonCode: credit.code,
    ip: args.ip ?? null,
  })

  return { ok: true, state: finalState, credit }
}

/**
 * What a customer would be told before confirming a skip.
 *
 * PRD section 21: "UI shows whether the occurrence will be credited before
 * confirmation." Shares its code path with the real decision, so the
 * warning and the outcome cannot disagree.
 */
export async function previewSkip(args: {
  db: Db
  occurrenceId: string
  actorUserId: string
  today: PlainDate
  policy?: SkipPolicy | undefined
}): Promise<
  { ok: true; credit: CreditDecision } | { ok: false; code: OccurrenceFailure; message: string }
> {
  const occ = await load(args.db, args.occurrenceId)
  if (!occ) return { ok: false, code: 'NOT_FOUND', message: 'No such occurrence.' }

  if (occ.customerUserId !== args.actorUserId) {
    return {
      ok: false,
      code: 'NOT_YOUR_OCCURRENCE',
      message: 'Only the customer on this subscription can preview a skip.',
    }
  }

  return {
    ok: true,
    credit: previewCustomerSkip({
      occurrenceValueCents: occ.serviceValueCents,
      serviceDate: parseServiceDate(occ.serviceDate),
      today: args.today,
      policy: args.policy ?? DEFAULT_SKIP_POLICY,
    }),
  }
}
