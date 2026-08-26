/**
 * Writing, answering and reporting reviews.
 *
 * The rules are in domain/review.ts; this checks them against the database
 * and writes the rows. Authorisation is resolved here rather than trusted
 * from the caller, and every decision that hides something is audited.
 *
 * ## Why no client writes
 *
 * 0021 revokes insert on both tables. Writing a review means proving the
 * visit was delivered, that it belongs to this customer, and that the cycle
 * has not already been reviewed -- three joins and a uniqueness rule that a
 * policy would express badly and that need to produce a readable message
 * when they fail.
 */

import {
  checkResponse,
  checkReviewContent,
  checkReviewEligibility,
  isReportReason,
  publicRating,
  shouldHideOnReport,
  type PublicRating,
  type ReportReason,
} from '@/domain/review'
import type { OccurrenceState } from '@/domain/occurrence'
import { parseServiceDate } from '@/server/occurrenceService'
import { isoDate } from '@/domain/schedule'
import { writeAudit } from '@/server/audit'
import type { PlainDate } from '@/domain/age'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'

type Db = SupabaseClient<Database>

export type ReviewFailure =
  | 'NOT_FOUND'
  | 'NOT_ELIGIBLE'
  | 'INVALID'
  | 'ALREADY_EXISTS'
  | 'WRITE_FAILED'

export type CreateReviewResult =
  | { ok: true; reviewId: string }
  | { ok: false; code: ReviewFailure; message: string }

/**
 * Leaves a review on a delivered visit.
 *
 * `db` must be the PRIVILEGED client: 0021 allows no client writes.
 */
export async function createReview(args: {
  db: Db
  occurrenceId: string
  actorUserId: string
  rating: unknown
  body?: unknown
  ip?: string | null
}): Promise<CreateReviewResult> {
  const { db, occurrenceId, actorUserId } = args

  const content = checkReviewContent({ rating: args.rating, body: args.body })
  if (!content.ok) return { ok: false, code: 'INVALID', message: content.message }

  const { data: occ } = await db
    .from('service_occurrences')
    .select(
      `id, state, service_date, subscription_id,
       subscriptions!inner (
         customer_user_id, provider_service_id, current_cycle_start,
         provider_services!inner (
           id,
           businesses!inner ( provider_user_id )
         )
       )`,
    )
    .eq('id', occurrenceId)
    .maybeSingle()

  if (!occ) return { ok: false, code: 'NOT_FOUND', message: 'No such visit.' }

  const one = <T,>(v: unknown): T | undefined => (Array.isArray(v) ? v[0] : v) as T | undefined

  const sub = one<{
    customer_user_id: string
    provider_service_id: string
    current_cycle_start: string | null
    provider_services: unknown
  }>(occ.subscriptions)
  const svc = one<{ id: string; businesses: unknown }>(sub?.provider_services)
  const biz = one<{ provider_user_id: string }>(svc?.businesses)

  if (!sub || !svc || !biz) {
    return { ok: false, code: 'NOT_FOUND', message: 'No such visit.' }
  }

  const { data: existingForOccurrence } = await db
    .from('reviews')
    .select('id')
    .eq('occurrence_id', occurrenceId)
    .maybeSingle()

  const { data: sameService } = await db
    .from('reviews')
    .select('cycle_start')
    .eq('customer_user_id', actorUserId)
    .eq('provider_service_id', svc.id)
    .not('cycle_start', 'is', null)

  const reviewedCycleStarts: PlainDate[] = (sameService ?? [])
    .map((r) => r.cycle_start)
    .filter((c): c is string => c !== null)
    .map(parseServiceDate)

  const cycleStart = sub.current_cycle_start ? parseServiceDate(sub.current_cycle_start) : null

  const eligibility = checkReviewEligibility({
    occurrenceState: occ.state as OccurrenceState,
    subscriptionCustomerUserId: sub.customer_user_id,
    actorUserId,
    occurrenceAlreadyReviewed: Boolean(existingForOccurrence),
    cycleStart,
    reviewedCycleStarts,
  })

  if (!eligibility.eligible) {
    return { ok: false, code: 'NOT_ELIGIBLE', message: eligibility.message }
  }

  const { data, error } = await db
    .from('reviews')
    .insert({
      occurrence_id: occurrenceId,
      subscription_id: occ.subscription_id,
      provider_service_id: svc.id,
      provider_user_id: biz.provider_user_id,
      customer_user_id: actorUserId,
      rating: content.rating,
      body: content.body,
      cycle_start: cycleStart ? isoDate(cycleStart) : null,
    })
    .select('id')
    .single()

  if (error) {
    // ux_one_review_per_cycle, under a double-tapped submit. The domain
    // check above gives the friendly message; this is the race.
    if (error.code === '23505') {
      return {
        ok: false,
        code: 'ALREADY_EXISTS',
        message: 'You have already left a review for this billing cycle.',
      }
    }
    console.error('[reviews] insert failed', error.message)
    return { ok: false, code: 'WRITE_FAILED', message: 'Could not save that. Try again.' }
  }

  return { ok: true, reviewId: data!.id }
}

export type RespondResult =
  | { ok: true }
  | { ok: false; code: ReviewFailure | 'NOT_AUTHORIZED'; message: string }

/** The provider's single public reply. */
export async function respondToReview(args: {
  db: Db
  reviewId: string
  actorUserId: string
  body: unknown
  ip?: string | null
}): Promise<RespondResult> {
  const { db, reviewId, actorUserId } = args

  const { data: review } = await db
    .from('reviews')
    .select('id, provider_user_id, response_body, state')
    .eq('id', reviewId)
    .maybeSingle()

  if (!review) return { ok: false, code: 'NOT_FOUND', message: 'No such review.' }

  const check = checkResponse({
    body: args.body,
    providerUserId: review.provider_user_id,
    actorUserId,
    existingResponse: review.response_body,
  })

  if (!check.ok) {
    const code = check.code === 'not_your_review' ? 'NOT_AUTHORIZED' : 'INVALID'
    return { ok: false, code, message: check.message }
  }

  const { error } = await db
    .from('reviews')
    .update({ response_body: check.body, responded_at: new Date().toISOString() })
    .eq('id', reviewId)
    // Only if still unanswered, so two submits cannot both land.
    .is('response_body', null)

  if (error) {
    console.error('[reviews] response failed', error.message)
    return { ok: false, code: 'WRITE_FAILED', message: 'Could not save that. Try again.' }
  }

  return { ok: true }
}

export type ReportResult =
  | { ok: true; hidden: boolean }
  | { ok: false; code: ReviewFailure | 'ALREADY_REPORTED'; message: string }

/**
 * Flags a review for moderation.
 *
 * Some reasons hide it immediately, before anyone has read the queue. A
 * wrongly hidden review costs a provider a day of one review not showing; a
 * review containing a customer's phone number or a threat aimed at a minor
 * stays public until somebody gets to it. Those costs are not comparable.
 */
export async function reportReview(args: {
  db: Db
  reviewId: string
  reporterUserId: string
  reason: unknown
  detail?: string | undefined
  ip?: string | null
}): Promise<ReportResult> {
  const { db, reviewId, reporterUserId } = args

  if (!isReportReason(args.reason)) {
    return { ok: false, code: 'INVALID', message: 'Choose a reason for the report.' }
  }
  const reason: ReportReason = args.reason

  const { data: review } = await db
    .from('reviews')
    .select('id, state')
    .eq('id', reviewId)
    .maybeSingle()

  if (!review) return { ok: false, code: 'NOT_FOUND', message: 'No such review.' }

  const { error: reportError } = await db.from('review_reports').insert({
    review_id: reviewId,
    reporter_user_id: reporterUserId,
    reason,
    detail: args.detail ?? null,
  })

  if (reportError) {
    if (reportError.code === '23505') {
      return {
        ok: false,
        code: 'ALREADY_REPORTED',
        message: 'You have already reported this review.',
      }
    }
    console.error('[reviews] report failed', reportError.message)
    return { ok: false, code: 'WRITE_FAILED', message: 'Could not save that. Try again.' }
  }

  let hidden = false
  if (shouldHideOnReport(reason) && review.state === 'published') {
    const { error } = await db
      .from('reviews')
      .update({ state: 'hidden' })
      .eq('id', reviewId)
      .eq('state', 'published')
    hidden = !error
  }

  await writeAudit({
    actorUserId: reporterUserId,
    actorRole: null,
    action: 'review.reported',
    targetType: 'review',
    targetId: reviewId,
    after: { reason, auto_hidden: hidden },
    reasonCode: reason,
    ip: args.ip ?? null,
  })

  return { ok: true, hidden }
}

/**
 * The rating a storefront may show for a service.
 *
 * Counts published reviews only -- a hidden one is not evidence of anything
 * until a human has looked at it.
 */
export async function getPublicRating(args: {
  db: Db
  providerServiceId: string
  minimum?: number | undefined
}): Promise<PublicRating> {
  const { data } = await args.db
    .from('reviews')
    .select('rating')
    .eq('provider_service_id', args.providerServiceId)
    .eq('state', 'published')

  return publicRating({
    ratings: (data ?? []).map((r) => r.rating),
    ...(args.minimum !== undefined ? { minimum: args.minimum } : {}),
  })
}
