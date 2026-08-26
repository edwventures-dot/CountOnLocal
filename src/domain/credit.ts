/**
 * Who pays when a visit does not happen.
 *
 * PRD section 12: "A provider-canceled occurrence automatically creates a
 * proportional service credit against the customer's next bill." Section 21
 * adds the other side: a customer pause has a "notice cutoff [that] is
 * service-configurable", and the UI must show "whether the occurrence will
 * be credited before confirmation."
 *
 * So the two skips are asymmetric on purpose:
 *
 *   provider skipped  -> always credited. The service was sold and not
 *                        delivered. Notice is irrelevant; a provider who
 *                        cancels with three weeks' warning still did not
 *                        do the work.
 *
 *   customer skipped  -> credited only with enough notice. Inside the
 *                        cutoff the slot is already spent: the provider
 *                        planned a route around that address and cannot
 *                        refill it same-day.
 *
 * Notice is measured in whole calendar days, not hours. That is a deliberate
 * limitation. Measuring hours would mean turning a local service window into
 * an instant, which needs IANA offset data and reintroduces exactly the DST
 * bug schedule.ts is written to avoid -- and "cancel by the day before" is
 * also what a person can actually hold in their head. If an hour-level
 * cutoff is ever genuinely needed, it should arrive with a real time zone
 * library rather than an offset guess.
 */

import type { PlainDate } from './age'
import { toEpochDay } from './schedule'

export type SkipReason =
  /** Provider vacation, illness, or any day the route does not run. */
  | 'provider_unavailable'
  /** Customer paused this visit. */
  | 'customer_requested'
  /** Trust and safety resolved a reported issue for the customer. */
  | 'issue_resolved_for_customer'

/**
 * Per-service policy. Service-configurable per PRD section 21, so it is
 * passed in rather than read from a constant.
 */
export type SkipPolicy = {
  /**
   * Whole days of notice a customer must give for a free skip. 1 means "by
   * the day before". 0 means same-day skips are still free, which is
   * generous but legitimate for something like plant watering.
   */
  customerNoticeDays: number
}

export const DEFAULT_SKIP_POLICY: SkipPolicy = {
  customerNoticeDays: 1,
}

export type CreditDecision = {
  credited: boolean
  /** Always >= 0. Zero when not credited. */
  amountCents: number
  /** Stable code for tests, analytics and the ledger memo. */
  code:
    | 'provider_did_not_deliver'
    | 'issue_resolved_for_customer'
    | 'customer_gave_notice'
    | 'customer_inside_cutoff'
  /** Sentence shown to whoever is looking at it. No jargon, no blame. */
  message: string
  /** Days of notice actually given. Null when notice is not the deciding factor. */
  noticeDays: number | null
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many
}

/**
 * Decide whether a skipped occurrence earns a credit, and for how much.
 *
 * `occurrenceValueCents` is that single visit's share of the cycle, already
 * stored on the occurrence row. Using the stored value rather than
 * recomputing it means a mid-cycle price change cannot retroactively alter
 * what an old visit was worth.
 */
export function decideSkipCredit(args: {
  reason: SkipReason
  occurrenceValueCents: number
  /** Civil date the service was due. */
  serviceDate: PlainDate
  /** Civil date the skip was requested. Only used for customer skips. */
  requestedOn?: PlainDate | undefined
  policy?: SkipPolicy | undefined
}): CreditDecision {
  const { reason, occurrenceValueCents, serviceDate, requestedOn } = args
  const policy = args.policy ?? DEFAULT_SKIP_POLICY

  if (!Number.isInteger(occurrenceValueCents)) {
    throw new TypeError('occurrenceValueCents must be an integer number of cents')
  }
  if (occurrenceValueCents < 0) {
    throw new RangeError('occurrenceValueCents cannot be negative')
  }

  if (reason === 'provider_unavailable') {
    return {
      credited: true,
      amountCents: occurrenceValueCents,
      code: 'provider_did_not_deliver',
      message: 'This service was not delivered, so it is credited to your next bill.',
      noticeDays: null,
    }
  }

  if (reason === 'issue_resolved_for_customer') {
    return {
      credited: true,
      amountCents: occurrenceValueCents,
      code: 'issue_resolved_for_customer',
      message: 'Your reported issue was resolved in your favour and this visit is credited.',
      noticeDays: null,
    }
  }

  // Customer requested. Notice decides it.
  if (!requestedOn) {
    throw new TypeError('requestedOn is required to judge notice on a customer skip')
  }

  const noticeDays = toEpochDay(serviceDate) - toEpochDay(requestedOn)

  if (noticeDays >= policy.customerNoticeDays) {
    return {
      credited: true,
      amountCents: occurrenceValueCents,
      code: 'customer_gave_notice',
      message: 'Skipped with enough notice, so you will not be billed for this visit.',
      noticeDays,
    }
  }

  const need = policy.customerNoticeDays
  return {
    credited: false,
    amountCents: 0,
    code: 'customer_inside_cutoff',
    message:
      need === 0
        ? 'This visit has already been served and will still be billed.'
        : `Skips need ${need} ${plural(need, 'day', 'days')} notice to be free, so this visit will still be billed.`,
    noticeDays,
  }
}

/**
 * What the customer would be told before confirming, per PRD section 21:
 * "UI shows whether the occurrence will be credited before confirmation."
 *
 * Same decision as decideSkipCredit, asked before the fact rather than
 * after, so the two can never disagree.
 */
export function previewCustomerSkip(args: {
  occurrenceValueCents: number
  serviceDate: PlainDate
  today: PlainDate
  policy?: SkipPolicy | undefined
}): CreditDecision {
  return decideSkipCredit({
    reason: 'customer_requested',
    occurrenceValueCents: args.occurrenceValueCents,
    serviceDate: args.serviceDate,
    requestedOn: args.today,
    policy: args.policy,
  })
}

/**
 * Total credit to carry into the next cycle.
 *
 * Feeds quoteCycle's creditCents. Summed here rather than in SQL so the
 * rounding and the guard against a negative total live with the rest of the
 * money rules.
 */
export function totalCredit(decisions: readonly CreditDecision[]): number {
  const sum = decisions.reduce((acc, d) => acc + (d.credited ? d.amountCents : 0), 0)
  return sum < 0 ? 0 : sum
}
