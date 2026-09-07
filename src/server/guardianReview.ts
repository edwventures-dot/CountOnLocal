/**
 * A person deciding whether a young provider can start.
 *
 * The guardian state machine has always had `manual_review`, with
 * REVIEW_APPROVE reaching `verified` and REVIEW_DENY reaching `revoked`.
 * Nothing ever routed into it, and auditCoverage.test.ts carried the
 * exemption saying exactly that. This is the missing half.
 *
 * ## What this is protecting against
 *
 * Not fraud, and not really the guardian. It is protecting against the
 * thing an online consent flow cannot catch: a situation that reads fine
 * on a form and wrong in person. A parent who has not understood what
 * they signed, a child who does not want to do this, an arrangement where
 * the adult is the one who wants the money. None of that is visible to
 * eleven checkboxes, and all of it is visible over a kitchen table.
 *
 * So the consent record stays the artifact of what was agreed, and this is
 * the artifact of somebody having looked.
 *
 * ## Why the reason is required and the meeting is recorded
 *
 * An approval with no reasoning is a rubber stamp with a timestamp. And if
 * the row only said "approved", the strongest part of the design -- that a
 * person met the family -- would be invisible to anyone reading the
 * records later, including a regulator, an insurer, or whoever runs this
 * when the owner does not.
 *
 * `met_in_person` is stored as the fact it is rather than assumed, because
 * the day someone approves one over the phone is exactly the day it should
 * be legible that they did.
 *
 * ## This does not scale, deliberately
 *
 * Young providers can only be added as fast as somebody can meet families.
 * At neighbourhood scale that is a morning. It is also the natural brake on
 * growing faster than the care can grow, which is the same instinct as the
 * route density rule: fill what you have before widening it.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'
import { transition, type GuardianState } from '@/domain/guardian'
import { hasPermission, roleGranting, type Role } from '@/domain/roles'
import { writeAudit } from '@/server/audit'

type Db = SupabaseClient<Database>

/**
 * Whether a signed consent needs a human before it counts.
 *
 * Defaults to ON when the setting cannot be read. The asymmetry is the
 * point: a wrong `on` means somebody waits for a phone call, and a wrong
 * `off` means a minor goes live unseen.
 */
export async function guardianManualReviewEnabled(db: Db): Promise<boolean> {
  const { data, error } = await db
    .from('platform_settings')
    .select('value')
    .eq('key', 'guardian_manual_review')
    .maybeSingle()

  if (error) {
    console.error('[guardian-review] could not read setting; assuming on', error.message)
    return true
  }

  // Absent means on, same as the database function in migration 0044.
  return data?.value !== 'off'
}

export type PendingReview = {
  relationshipId: string
  providerUserId: string
  guardianUserId: string | null
  providerFirstName: string | null
  state: GuardianState
  consentedAt: string | null
}

/** Young providers waiting on somebody to meet them. */
export async function listPendingReviews(db: Db): Promise<PendingReview[]> {
  const { data, error } = await db
    .from('guardian_relationships')
    .select('id, provider_user_id, guardian_user_id, state, consented_at')
    .eq('state', 'manual_review')
    .order('consented_at', { ascending: true })

  if (error) {
    console.error('[guardian-review] could not list', error.message)
    return []
  }

  const rows = data ?? []
  if (rows.length === 0) return []

  // The provider's first name only. A review list is an operational screen
  // and CLAUDE.md rule 1 does not stop applying because the reader is the
  // owner -- there is no reason for a date of birth to be on it.
  const { data: profiles } = await db
    .from('provider_profiles')
    .select('user_id, display_first_name')
    .in(
      'user_id',
      rows.map((r) => r.provider_user_id),
    )

  const names = new Map((profiles ?? []).map((p) => [p.user_id, p.display_first_name]))

  return rows.map((r) => ({
    relationshipId: r.id,
    providerUserId: r.provider_user_id,
    guardianUserId: r.guardian_user_id,
    providerFirstName: names.get(r.provider_user_id) ?? null,
    state: r.state as GuardianState,
    consentedAt: r.consented_at,
  }))
}

export type ReviewResult =
  | { ok: true; state: GuardianState; reviewId: string }
  | {
      ok: false
      code:
        | 'NOT_AUTHORIZED'
        | 'NOT_FOUND'
        | 'ILLEGAL_TRANSITION'
        | 'REASON_REQUIRED'
        | 'WRITE_FAILED'
      message: string
    }

/**
 * Approves or denies a young provider, and records that somebody looked.
 *
 * The review row is written BEFORE the state moves. If the state change
 * failed afterwards the worst case is a recorded decision that did not take
 * effect, which is visible and fixable. The reverse -- a minor verified
 * with no record of who decided that -- is the thing rule 9 exists to
 * prevent.
 */
export async function reviewGuardianRelationship(args: {
  db: Db
  relationshipId: string
  reviewerUserId: string
  /** The reviewer's roles, from the session. Never from the request body. */
  reviewerRoles: readonly Role[]
  approve: boolean
  reason: string
  metInPerson: boolean
  /** Who was in the room. Free text, optional. */
  present?: string | null
}): Promise<ReviewResult> {
  // Rule 7: authorization is server-side and role-based. A guardian cannot
  // approve their own relationship -- they already gave their consent, and
  // this is the separate question of whether somebody else agrees the
  // arrangement is sound.
  if (!hasPermission(args.reviewerRoles, 'guardian:review')) {
    return {
      ok: false,
      code: 'NOT_AUTHORIZED',
      message: 'You cannot approve a young provider.',
    }
  }

  const reason = args.reason.trim()
  if (reason.length < 3) {
    return {
      ok: false,
      code: 'REASON_REQUIRED',
      message: 'Say why. An approval with no reasoning is not a record of a decision.',
    }
  }

  const { data: rel } = await args.db
    .from('guardian_relationships')
    .select('id, state, provider_user_id, guardian_user_id')
    .eq('id', args.relationshipId)
    .maybeSingle()

  if (!rel) return { ok: false, code: 'NOT_FOUND', message: 'No such relationship.' }

  // manual_review is only reachable after a guardian signed consent, so a
  // null guardian here means the relationship is in a state it should not
  // be able to occupy. Refused rather than coerced: writing a review row
  // that names nobody as the guardian would record a decision about an
  // arrangement we cannot describe.
  if (!rel.guardian_user_id) {
    return {
      ok: false,
      code: 'ILLEGAL_TRANSITION',
      message: 'That relationship has no guardian attached, so there is nothing to approve.',
    }
  }

  const event = args.approve ? 'REVIEW_APPROVE' : 'REVIEW_DENY'
  const moved = transition(rel.state as GuardianState, event)
  if (!moved.ok) {
    return {
      ok: false,
      code: 'ILLEGAL_TRANSITION',
      message: `A relationship in ${rel.state} cannot be ${args.approve ? 'approved' : 'denied'}.`,
    }
  }

  const { data: review, error: reviewError } = await args.db
    .from('guardian_reviews')
    .insert({
      relationship_id: rel.id,
      provider_user_id: rel.provider_user_id,
      guardian_user_id: rel.guardian_user_id,
      decision: args.approve ? 'approved' : 'denied',
      reason,
      met_in_person: args.metInPerson,
      present: args.present ?? null,
      reviewed_by_user_id: args.reviewerUserId,
    })
    .select('id')
    .single()

  if (reviewError || !review) {
    console.error('[guardian-review] could not record', reviewError?.message)
    return { ok: false, code: 'WRITE_FAILED', message: 'Could not record that decision.' }
  }

  const { error: moveError } = await args.db
    .from('guardian_relationships')
    .update({
      state: moved.to,
      // revoked_requires_timestamp: the table refuses a revoked row with no
      // revoked_at, which is right -- "revoked" with no time is not a record
      // of anything. Found by the test rather than by reading the schema.
      ...(moved.to === 'revoked' ? { revoked_at: new Date().toISOString() } : {}),
    })
    .eq('id', rel.id)
    // Optimistic: if something else moved the relationship since it was
    // read, this updates nothing rather than overwriting that change.
    .eq('state', rel.state)

  if (moveError) {
    console.error('[guardian-review] could not move state', moveError.message)
    return { ok: false, code: 'WRITE_FAILED', message: 'Could not apply that decision.' }
  }

  await args.db
    .from('provider_profiles')
    .update({ guardian_state: moved.to })
    .eq('user_id', rel.provider_user_id)

  await writeAudit({
    actorUserId: args.reviewerUserId,
    // The role that actually granted this, not roles[0] -- the same bug
    // adminService fixed when staff actions were logged as 'customer'.
    actorRole: roleGranting([...args.reviewerRoles], 'guardian:review') ?? 'platform_admin',
    action: args.approve ? 'guardian.review_approved' : 'guardian.review_denied',
    targetType: 'guardian_relationship',
    targetId: rel.id,
    reasonCode: args.approve ? 'REVIEW_APPROVED' : 'REVIEW_DENIED',
    before: { state: rel.state },
    after: {
      state: moved.to,
      guardian_review_id: review.id,
      met_in_person: args.metInPerson,
    },
  })

  return { ok: true, state: moved.to, reviewId: review.id }
}
