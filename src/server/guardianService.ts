/**
 * Guardian relationship endpoints (API_CONTRACT, Auth / onboarding).
 *
 * Every state change here goes through domain/guardian.transition(), so an
 * illegal edge is impossible to reach even if a handler is called out of
 * order. The database row is only written after the transition says yes.
 */

import { z } from 'zod'
import { transition, type GuardianState } from '@/domain/guardian'
import { writeAudit } from '@/server/audit'
import {
  generateInvitationToken,
  hashInvitationToken,
  invitationExpiryFrom,
  isExpired,
} from '@/server/invitationToken'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'

type Db = SupabaseClient<Database>

export const inviteSchema = z
  .object({
    email: z.string().email().optional(),
    phone: z.string().min(7).max(20).optional(),
  })
  .refine((v) => Boolean(v.email ?? v.phone), {
    message: 'An email address or phone number is required',
  })

export type InviteInput = z.infer<typeof inviteSchema>

export type InviteResult =
  | { ok: true; relationshipId: string; token: string; expiresAt: string; state: GuardianState }
  | { ok: false; code: 'NO_PROVIDER_PROFILE' | 'ILLEGAL_GUARDIAN_TRANSITION' | 'WRITE_FAILED' }

/**
 * Creates or reissues a guardian invitation.
 *
 * The raw token is returned to the caller exactly once, for delivery by
 * email or SMS. It is never written to the database, the audit log, or the
 * application log -- only its hash is stored.
 *
 * `db` must be the PRIVILEGED client. Clients hold no write grant on
 * guardian_relationships, so that every transition goes through the domain
 * state machine here and lands an audit row. providerUserId comes from the
 * authenticated session, never from the request body.
 */
export async function createGuardianInvitation(args: {
  db: Db
  providerUserId: string
  input: InviteInput
  now: Date
  ip?: string | null
}): Promise<InviteResult> {
  const { db, providerUserId, input, now } = args

  const { data: profile } = await db
    .from('provider_profiles')
    .select('user_id, guardian_state')
    .eq('user_id', providerUserId)
    .maybeSingle()

  if (!profile) return { ok: false, code: 'NO_PROVIDER_PROFILE' }

  const current = profile.guardian_state
  // Reissuing to an already-invited guardian is a resend, not a new invite.
  const event = current === 'invited' ? 'RESEND_INVITE' : 'INVITE'
  const result = transition(current, event)
  if (!result.ok) return { ok: false, code: 'ILLEGAL_GUARDIAN_TRANSITION' }

  const token = generateInvitationToken()
  const expiresAt = invitationExpiryFrom(now).toISOString()

  const fields = {
    invitation_email: input.email ?? null,
    invitation_phone: input.phone ?? null,
    invitation_token_hash: hashInvitationToken(token),
    invitation_expires_at: expiresAt,
    state: result.to,
  }

  // Deliberately not an upsert. The unique index on provider_user_id is
  // partial -- it excludes revoked and expired rows so history survives --
  // and Postgres will not use a partial index for ON CONFLICT. More
  // importantly, re-inviting after a revocation should leave the revoked
  // row intact as an audit record and open a NEW relationship, not
  // overwrite the evidence that consent was once withdrawn.
  const { data: live } = await db
    .from('guardian_relationships')
    .select('id')
    .eq('provider_user_id', providerUserId)
    .not('state', 'in', '(revoked,expired)')
    .maybeSingle()

  const written = live
    ? await db.from('guardian_relationships').update(fields).eq('id', live.id).select('id').single()
    : await db
        .from('guardian_relationships')
        .insert({ provider_user_id: providerUserId, ...fields })
        .select('id')
        .single()

  const row = written.data
  if (written.error || !row) {
    console.error('[guardian] invitation write failed', written.error?.message)
    return { ok: false, code: 'WRITE_FAILED' }
  }

  const { error: stateError } = await db
    .from('provider_profiles')
    .update({ guardian_state: result.to })
    .eq('user_id', providerUserId)
  if (stateError) {
    console.error('[guardian] provider state sync failed', stateError.message)
    return { ok: false, code: 'WRITE_FAILED' }
  }

  await writeAudit({
    actorUserId: providerUserId,
    actorRole: 'provider',
    action: event === 'RESEND_INVITE' ? 'guardian.invitation_resent' : 'guardian.invited',
    targetType: 'guardian_relationship',
    targetId: row.id,
    before: { state: current },
    after: { state: result.to },
    ip: args.ip ?? null,
  })

  return { ok: true, relationshipId: row.id, token, expiresAt, state: result.to }
}

export type AcceptResult =
  | { ok: true; relationshipId: string; providerUserId: string; state: GuardianState }
  | {
      ok: false
      code: 'INVALID_TOKEN' | 'INVITATION_EXPIRED' | 'ILLEGAL_GUARDIAN_TRANSITION' | 'WRITE_FAILED'
    }

/**
 * Guardian opens the invitation link and accepts.
 *
 * Looked up by token hash, so an invalid token and a token for someone
 * other than the caller are indistinguishable from outside -- both return
 * INVALID_TOKEN with no hint that the relationship exists.
 *
 * Requires the privileged client: the guardian is not yet linked to
 * anything, so no row level policy could grant them this read.
 */
export async function acceptGuardianInvitation(args: {
  adminDb: Db
  token: string
  guardianUserId: string
  now: Date
  ip?: string | null
}): Promise<AcceptResult> {
  const { adminDb, token, guardianUserId, now } = args

  const { data: rel } = await adminDb
    .from('guardian_relationships')
    .select('id, provider_user_id, state, invitation_expires_at')
    .eq('invitation_token_hash', hashInvitationToken(token))
    .maybeSingle()

  if (!rel) return { ok: false, code: 'INVALID_TOKEN' }

  if (isExpired(rel.invitation_expires_at, now)) {
    const expiry = transition(rel.state, 'EXPIRE')
    if (expiry.ok) {
      await adminDb.from('guardian_relationships').update({ state: expiry.to }).eq('id', rel.id)
      await adminDb
        .from('provider_profiles')
        .update({ guardian_state: expiry.to })
        .eq('user_id', rel.provider_user_id)
      await writeAudit({
        actorUserId: null,
        actorRole: 'system',
        action: 'guardian.expired',
        targetType: 'guardian_relationship',
        targetId: rel.id,
        before: { state: rel.state },
        after: { state: expiry.to },
      })
    }
    return { ok: false, code: 'INVITATION_EXPIRED' }
  }

  const result = transition(rel.state, 'GUARDIAN_OPENED')
  if (!result.ok) return { ok: false, code: 'ILLEGAL_GUARDIAN_TRANSITION' }

  // Ensure a guardian profile and role exist before linking.
  await adminDb
    .from('guardian_profiles')
    .upsert({ user_id: guardianUserId }, { onConflict: 'user_id' })
  await adminDb
    .from('user_roles')
    .upsert({ user_id: guardianUserId, role: 'guardian' }, { onConflict: 'user_id,role' })

  const { error } = await adminDb
    .from('guardian_relationships')
    .update({
      guardian_user_id: guardianUserId,
      state: result.to,
      // The token is single-use: consumed on acceptance so the emailed link
      // cannot be replayed by anyone who later reads the message.
      invitation_token_hash: null,
    })
    .eq('id', rel.id)

  if (error) {
    console.error('[guardian] accept write failed', error.message)
    return { ok: false, code: 'WRITE_FAILED' }
  }

  await adminDb
    .from('provider_profiles')
    .update({ guardian_state: result.to })
    .eq('user_id', rel.provider_user_id)

  await writeAudit({
    actorUserId: guardianUserId,
    actorRole: 'guardian',
    action: 'guardian.accepted',
    targetType: 'guardian_relationship',
    targetId: rel.id,
    before: { state: rel.state },
    after: { state: result.to },
    ip: args.ip ?? null,
  })

  return { ok: true, relationshipId: rel.id, providerUserId: rel.provider_user_id, state: result.to }
}

export type RevokeResult =
  | { ok: true; relationshipId: string; state: GuardianState }
  | {
      ok: false
      code: 'NOT_FOUND' | 'NOT_AUTHORIZED' | 'ILLEGAL_GUARDIAN_TRANSITION' | 'WRITE_FAILED'
    }

/**
 * Guardian (or trust and safety) revokes consent.
 *
 * SAFETY_TRUST_POLICY section 2 requires that on revocation the business
 * pauses, no new customers can subscribe, and future charges stop. The
 * latter two are already enforced live by domain/gates.ts, which reads
 * guardian state on every attempt rather than a cached flag -- so they take
 * effect the moment this row is written, with no job to run and no cache to
 * bust.
 *
 * `db` must be the PRIVILEGED client, for the same reason as the other
 * mutations. Ownership is checked explicitly below rather than by policy.
 *
 * NOT YET WIRED: setting businesses.state to `paused_guardian`. The
 * businesses table arrives in build-sequence step 3; until it exists there
 * is nothing to pause. User-visible behaviour is already correct because
 * the gates deny publish and checkout, but the explicit paused_guardian
 * write must be added here when step 3 lands.
 */
export async function revokeGuardianRelationship(args: {
  db: Db
  relationshipId: string
  actorUserId: string
  actorRole: 'guardian' | 'trust_safety_agent'
  reasonCode?: string | null
  now: Date
  ip?: string | null
}): Promise<RevokeResult> {
  const { db, relationshipId, actorUserId, actorRole, now } = args

  const { data: rel } = await db
    .from('guardian_relationships')
    .select('id, provider_user_id, guardian_user_id, state')
    .eq('id', relationshipId)
    .maybeSingle()

  if (!rel) return { ok: false, code: 'NOT_FOUND' }

  // A guardian may only revoke their own relationship. Trust and safety may
  // revoke any, and that action is audited with a reason code.
  if (actorRole === 'guardian' && rel.guardian_user_id !== actorUserId) {
    return { ok: false, code: 'NOT_AUTHORIZED' }
  }

  const result = transition(rel.state, 'REVOKE')
  if (!result.ok) return { ok: false, code: 'ILLEGAL_GUARDIAN_TRANSITION' }

  const { error } = await db
    .from('guardian_relationships')
    .update({ state: result.to, revoked_at: now.toISOString() })
    .eq('id', rel.id)

  if (error) {
    console.error('[guardian] revoke write failed', error.message)
    return { ok: false, code: 'WRITE_FAILED' }
  }

  await db
    .from('provider_profiles')
    .update({ guardian_state: result.to })
    .eq('user_id', rel.provider_user_id)

  await writeAudit({
    actorUserId,
    actorRole,
    action: 'guardian.revoked',
    targetType: 'guardian_relationship',
    targetId: rel.id,
    before: { state: rel.state },
    after: { state: result.to },
    reasonCode: args.reasonCode ?? null,
    ip: args.ip ?? null,
  })

  return { ok: true, relationshipId: rel.id, state: result.to }
}
