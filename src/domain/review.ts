/**
 * Reviews, and when a rating is allowed to exist.
 *
 * PRD section 19 is short but every line is a rule:
 *
 *   - only completed paid occurrences can generate a review;
 *   - one prompt per billing cycle per service, configurable;
 *   - 1 to 5 stars plus short text;
 *   - the provider gets exactly one public response;
 *   - abuse reporting is required;
 *   - and a provider has no public rating at all until a minimum number of
 *     completed reviews exists -- recommended three.
 *
 * ## Why the threshold is not a nicety
 *
 * That last rule reads like a statistics preference and is not. A public
 * rating on this platform attaches to a named fourteen-year-old. One
 * annoyed neighbour leaving one star on a $3 bin service would otherwise
 * define that child's public reputation permanently, with no body of work
 * to weigh it against.
 *
 * So below the threshold the reviews exist, the provider can see them, and
 * the storefront shows no score. Not a rounded score, not a provisional
 * one -- none, with an honest label saying why. Showing "5.0 (1)" invites
 * exactly the reading the rule exists to prevent.
 *
 * ## What a review is attached to
 *
 * An occurrence, not a subscription. A review is about a visit that
 * happened, which is what makes it verifiable -- there is a completed,
 * settled row behind every one, and no way to review a service you never
 * received.
 */

import { DELIVERED_STATES, type OccurrenceState } from './occurrence'
import type { PlainDate } from './age'
import { toEpochDay } from './schedule'

export const MIN_RATING = 1
export const MAX_RATING = 5
export const MAX_BODY_LENGTH = 1000
export const MAX_RESPONSE_LENGTH = 1000

/**
 * Completed reviews a provider needs before a public score appears.
 *
 * PRD section 19's recommendation. Configuration rather than a constant, so
 * a market that wants a different number does not need a code change.
 */
export const DEFAULT_MIN_REVIEWS_FOR_PUBLIC_RATING = 3

export type ReviewEligibility =
  | { eligible: true }
  | {
      eligible: false
      code:
        | 'occurrence_not_delivered'
        | 'not_your_service'
        | 'already_reviewed'
        | 'cycle_already_reviewed'
      message: string
    }

/**
 * May this customer review this visit?
 *
 * `reviewedCycleStarts` is the set of cycle start dates the customer has
 * already reviewed for this service. One review per cycle per service is
 * PRD section 19's anti-spam rule, and comparing cycle starts is how it is
 * enforced without a second table.
 */
export function checkReviewEligibility(args: {
  occurrenceState: OccurrenceState
  /** The customer on the subscription this occurrence belongs to. */
  subscriptionCustomerUserId: string
  /** Who is trying to write it. */
  actorUserId: string
  /** True when this specific occurrence already has a review. */
  occurrenceAlreadyReviewed: boolean
  /** Cycle start this occurrence falls in. */
  cycleStart: PlainDate | null
  /** Cycle starts already reviewed for this service by this customer. */
  reviewedCycleStarts: readonly PlainDate[]
}): ReviewEligibility {
  if (args.subscriptionCustomerUserId !== args.actorUserId) {
    return {
      eligible: false,
      code: 'not_your_service',
      message: 'Only the customer who received the service can review it.',
    }
  }

  // "Only completed paid occurrences." Delivered means completed or
  // settled -- a skipped, credited or cancelled visit did not happen, and
  // reviewing something that did not happen is not a review of anything.
  if (!DELIVERED_STATES.has(args.occurrenceState)) {
    return {
      eligible: false,
      code: 'occurrence_not_delivered',
      message: 'You can review a visit once it has been completed.',
    }
  }

  if (args.occurrenceAlreadyReviewed) {
    return {
      eligible: false,
      code: 'already_reviewed',
      message: 'You have already reviewed this visit.',
    }
  }

  if (args.cycleStart) {
    const start = toEpochDay(args.cycleStart)
    if (args.reviewedCycleStarts.some((c) => toEpochDay(c) === start)) {
      return {
        eligible: false,
        code: 'cycle_already_reviewed',
        message: 'You have already left a review for this billing cycle.',
      }
    }
  }

  return { eligible: true }
}

export type ReviewContentCheck =
  | { ok: true; rating: number; body: string | null }
  | { ok: false; field: 'rating' | 'body'; message: string }

/** Validates and normalises what a customer wrote. */
export function checkReviewContent(args: {
  rating: unknown
  body?: unknown
}): ReviewContentCheck {
  const rating = args.rating

  if (typeof rating !== 'number' || !Number.isInteger(rating)) {
    return { ok: false, field: 'rating', message: 'Choose a rating from 1 to 5.' }
  }
  if (rating < MIN_RATING || rating > MAX_RATING) {
    return { ok: false, field: 'rating', message: 'Choose a rating from 1 to 5.' }
  }

  let body: string | null = null
  if (args.body !== undefined && args.body !== null) {
    if (typeof args.body !== 'string') {
      return { ok: false, field: 'body', message: 'Write your review as text.' }
    }
    const trimmed = args.body.trim()
    if (trimmed.length > MAX_BODY_LENGTH) {
      return {
        ok: false,
        field: 'body',
        message: `Keep it under ${MAX_BODY_LENGTH} characters.`,
      }
    }
    body = trimmed.length > 0 ? trimmed : null
  }

  return { ok: true, rating, body }
}

export type PublicRating =
  | { visible: true; average: number; count: number }
  | {
      visible: false
      count: number
      /** Shown instead of a score. Honest about why there is none. */
      label: string
    }

/**
 * The score a storefront may display.
 *
 * Below the threshold this returns no number at all -- not a rounded one,
 * not a provisional one. A "5.0 from 1 review" on a minor's public page is
 * the thing PRD section 19 is guarding against, and showing it with a small
 * count next to it does not undo that.
 *
 * The average is rounded to one decimal, half away from zero, so it matches
 * what anyone gets doing the arithmetic themselves.
 */
export function publicRating(args: {
  ratings: readonly number[]
  minimum?: number | undefined
}): PublicRating {
  const minimum = args.minimum ?? DEFAULT_MIN_REVIEWS_FOR_PUBLIC_RATING
  const count = args.ratings.length

  if (count < minimum) {
    const remaining = minimum - count
    return {
      visible: false,
      count,
      label:
        count === 0
          ? 'No reviews yet'
          : `Rating appears after ${remaining} more review${remaining === 1 ? '' : 's'}`,
    }
  }

  const total = args.ratings.reduce((a, r) => a + r, 0)
  // Integer arithmetic then divide, so 4.25 rounds to 4.3 rather than
  // whatever the binary representation of the mean happens to be.
  const average = Math.round((total * 10) / count) / 10

  return { visible: true, average, count }
}

export type ResponseCheck =
  | { ok: true; body: string }
  | { ok: false; code: 'already_responded' | 'not_your_review' | 'empty' | 'too_long'; message: string }

/**
 * A provider's single public reply.
 *
 * One, per PRD section 19. Not editable here either: a reply that can be
 * rewritten after the fact is a reply a customer cannot rely on having
 * read, and the moderation queue would be looking at a moving target.
 */
export function checkResponse(args: {
  body: unknown
  providerUserId: string
  actorUserId: string
  existingResponse: string | null
}): ResponseCheck {
  if (args.providerUserId !== args.actorUserId) {
    return {
      ok: false,
      code: 'not_your_review',
      message: 'Only the provider who did the work can respond.',
    }
  }
  if (args.existingResponse !== null) {
    return {
      ok: false,
      code: 'already_responded',
      message: 'You have already responded to this review.',
    }
  }
  if (typeof args.body !== 'string' || !args.body.trim()) {
    return { ok: false, code: 'empty', message: 'Write a response first.' }
  }

  const trimmed = args.body.trim()
  if (trimmed.length > MAX_RESPONSE_LENGTH) {
    return {
      ok: false,
      code: 'too_long',
      message: `Keep it under ${MAX_RESPONSE_LENGTH} characters.`,
    }
  }

  return { ok: true, body: trimmed }
}

/** Why somebody flagged a review. Drives the moderation queue. */
export const REPORT_REASONS = [
  'not_about_this_service',
  'personal_information',
  'harassment',
  'sexual_content',
  'threat',
  'spam_or_advertising',
  'off_platform_contact',
  'other',
] as const

export type ReportReason = (typeof REPORT_REASONS)[number]

export function isReportReason(v: unknown): v is ReportReason {
  return typeof v === 'string' && (REPORT_REASONS as readonly string[]).includes(v)
}

/**
 * Reports that take a review out of public view the moment they are made,
 * before a human has looked.
 *
 * The asymmetry is deliberate. A wrongly hidden review costs the provider a
 * day of one review not showing. A review containing a customer's phone
 * number, a threat, or sexual content aimed at a minor stays public for as
 * long as it takes somebody to read the queue. Those are not the same cost.
 */
export const AUTO_HIDE_REASONS: ReadonlySet<ReportReason> = new Set([
  'personal_information',
  'harassment',
  'sexual_content',
  'threat',
])

export function shouldHideOnReport(reason: ReportReason): boolean {
  return AUTO_HIDE_REASONS.has(reason)
}
