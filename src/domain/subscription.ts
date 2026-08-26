/**
 * The subscription lifecycle, and what ending one owes.
 *
 * PRD section 16 is short and absolute: "Cancellation must be self-service.
 * No 'contact support to cancel' dark pattern." Everything here is built so
 * a customer can end the arrangement themselves, immediately, and be told
 * the money consequences before they confirm rather than after.
 *
 * ## Pausing is not a smaller cancellation
 *
 * A cycle is billed in advance, so a customer who pauses mid-cycle has
 * already paid for visits that will not now happen. Those are released one
 * by one through the same notice rules a single skip uses -- pausing is not
 * a way to get a refund on tomorrow's visit that skipping would not have
 * given, and it is not a way to lose one either.
 *
 * The subscription state stops the NEXT cycle being charged. The
 * occurrence-level decisions handle the cycle already paid for. Two
 * mechanisms, because they answer two different questions.
 *
 * ## Cancelling
 *
 * Same release of the remaining paid visits, then the state becomes
 * terminal so nothing further is generated or charged. Whatever credit is
 * left over has nowhere to go -- PRD section 12: "If the subscription ends
 * first, the balance is refundable." So a cancellation plan reports a
 * refundable amount, and it is the caller's job to actually move it.
 */

import type { PlainDate } from './age'
import { comparePlainDate } from './age'
import { decideSkipCredit, type CreditDecision, type SkipPolicy } from './credit'
import type { OccurrenceState } from './occurrence'

export type SubscriptionState =
  | 'pending'
  | 'active'
  | 'paused'
  | 'payment_failed'
  | 'canceled'
  | 'ended'

/** Who is asking. A customer may end their own; the system ends others. */
export type SubscriptionActor = 'customer' | 'provider' | 'system' | 'admin'

type Edge = { from: SubscriptionState; to: SubscriptionState; by: readonly SubscriptionActor[] }

/**
 * Legal moves. An allowlist for the same reason the occurrence machine uses
 * one: a missing allow is a support ticket, a missing deny is a
 * subscription that resurrects itself after cancellation.
 */
export const SUBSCRIPTION_EDGES: readonly Edge[] = [
  { from: 'pending', to: 'active', by: ['system'] },
  { from: 'pending', to: 'canceled', by: ['customer', 'system'] },

  { from: 'active', to: 'paused', by: ['customer'] },
  { from: 'active', to: 'payment_failed', by: ['system'] },
  { from: 'active', to: 'canceled', by: ['customer', 'admin'] },
  { from: 'active', to: 'ended', by: ['system'] },

  { from: 'paused', to: 'active', by: ['customer'] },
  { from: 'paused', to: 'canceled', by: ['customer', 'admin'] },
  { from: 'paused', to: 'ended', by: ['system'] },

  // A failed payment is recoverable: a new card and the next run resumes.
  { from: 'payment_failed', to: 'active', by: ['system'] },
  { from: 'payment_failed', to: 'canceled', by: ['customer', 'admin'] },
  { from: 'payment_failed', to: 'ended', by: ['system'] },
]

/** Nothing leaves these. A cancelled subscription is not resumed, it is replaced. */
export const TERMINAL_SUBSCRIPTION_STATES: ReadonlySet<SubscriptionState> = new Set([
  'canceled',
  'ended',
])

/** States where the platform keeps generating and charging. */
export const LIVE_SUBSCRIPTION_STATES: ReadonlySet<SubscriptionState> = new Set([
  'pending',
  'active',
  'paused',
  'payment_failed',
])

export type SubscriptionMove =
  | { ok: true }
  | { ok: false; code: 'unknown_transition' | 'wrong_actor'; message: string }

export function canMoveSubscription(args: {
  from: SubscriptionState
  to: SubscriptionState
  actor: SubscriptionActor
}): SubscriptionMove {
  const edge = SUBSCRIPTION_EDGES.find((e) => e.from === args.from && e.to === args.to)

  if (!edge) {
    const options = SUBSCRIPTION_EDGES.filter((e) => e.from === args.from).map((e) => e.to)
    return {
      ok: false,
      code: 'unknown_transition',
      message: options.length
        ? `A ${args.from} subscription cannot become ${args.to}. It can become: ${options.join(', ')}.`
        : `A ${args.from} subscription is final.`,
    }
  }

  if (!edge.by.includes(args.actor)) {
    return {
      ok: false,
      code: 'wrong_actor',
      message: `${args.from} to ${args.to} is done by ${edge.by.join(' or ')}, not ${args.actor}.`,
    }
  }

  return { ok: true }
}

/** An occurrence considered for release when pausing or cancelling. */
export type ReleasableOccurrence = {
  id: string
  state: OccurrenceState
  serviceDate: PlainDate
  valueCents: number
  /**
   * This visit's share of the cycle fee. A credit reverses all three sides
   * of a visit -- service, provider earning, platform fee -- so a refund
   * that counted only the service value would short the customer by the fee
   * they actually paid. See domain/ledger.creditEntries.
   */
  feeShareCents: number
}

export type ReleaseDecision = {
  occurrenceId: string
  credit: CreditDecision
}

export type EndingPlan = {
  /** Visits released, with the credit decision for each. */
  released: ReleaseDecision[]
  /** Credit these releases generate, in cents. Service plus fee share. */
  newCreditCents: number
  /** Visits left alone because they are already done or already terminal. */
  untouched: string[]
  /**
   * Credit with nowhere left to go once the subscription ends. Zero when
   * pausing, because a paused subscription may still resume and spend it.
   */
  refundableCents: number
  /** First date on which no service will happen. */
  effectiveFrom: PlainDate
}

/**
 * Works out what pausing or cancelling releases, and what it owes.
 *
 * Only future work is released. A visit that already happened stays
 * completed and stays billable -- ending a subscription is not a way to
 * retroactively unpay for work someone actually did.
 */
export function planEnding(args: {
  occurrences: readonly ReleasableOccurrence[]
  today: PlainDate
  /** Credit already sitting on the ledger before this. */
  standingCreditCents: number
  policy?: SkipPolicy | undefined
  /** A pause may resume, so its leftover credit is not refunded. */
  ending: 'pause' | 'cancel'
}): EndingPlan {
  if (!Number.isInteger(args.standingCreditCents) || args.standingCreditCents < 0) {
    throw new RangeError('standingCreditCents must be a non-negative integer')
  }

  const released: ReleaseDecision[] = []
  const untouched: string[] = []

  for (const occ of args.occurrences) {
    const isFuture = comparePlainDate(occ.serviceDate, args.today) >= 0
    const releasable = occ.state === 'scheduled' || occ.state === 'due_today'

    if (!isFuture || !releasable) {
      untouched.push(occ.id)
      continue
    }

    released.push({
      occurrenceId: occ.id,
      // Judged as a customer skip, under the same notice rules. Pausing is
      // not a back door to a credit a skip would have refused, and not a
      // way to lose one it would have granted.
      credit: decideSkipCredit({
        reason: 'customer_requested',
        occurrenceValueCents: occ.valueCents,
        serviceDate: occ.serviceDate,
        requestedOn: args.today,
        policy: args.policy,
      }),
    })
  }

  const feeShareOf = new Map(args.occurrences.map((o) => [o.id, o.feeShareCents]))

  // Service plus fee: what the customer actually paid for the visit, which
  // is what a credit gives back.
  const newCreditCents = released.reduce(
    (sum, r) =>
      sum + (r.credit.credited ? r.credit.amountCents + (feeShareOf.get(r.occurrenceId) ?? 0) : 0),
    0,
  )

  // On a cancellation everything left over is refundable, including credit
  // that was standing before this. On a pause nothing is: the subscription
  // may resume and spend it on the next cycle.
  const refundableCents =
    args.ending === 'cancel' ? args.standingCreditCents + newCreditCents : 0

  return {
    released,
    newCreditCents,
    untouched,
    refundableCents,
    effectiveFrom: args.today,
  }
}
