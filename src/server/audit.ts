/**
 * Append-only audit log writer.
 *
 * CLAUDE.md rule 9 lists the actions that must be recorded: guardian
 * approval and revocation, publish state, admin address access, payout
 * holds, refunds above threshold, incidents, suspensions, role changes.
 *
 * Two rules hold everywhere in this file:
 *   - raw IP addresses are never stored, only a salted hash;
 *   - before/after snapshots are redacted before they are written, because
 *     an audit row that quietly copies a date of birth or a gate code into
 *     before_json has just leaked it into a second table
 *     (SAFETY_TRUST_POLICY sections 14 and 17).
 */

import { createHash } from 'node:crypto'
import { serverEnv } from '@/lib/env'
import { supabaseAdmin } from '@/lib/supabase/admin'

export type AuditAction =
  | 'guardian.invited'
  | 'guardian.invitation_resent'
  | 'guardian.accepted'
  | 'guardian.verified'
  | 'guardian.revoked'
  | 'guardian.expired'
  | 'guardian.flagged_for_review'
  | 'guardian.aged_out'
  | 'provider.onboarding_started'
  | 'provider.registration_refused'
  | 'payout.account_created'
  | 'payout.onboarding_link_created'
  | 'payout.account_ready'
  | 'payout.requirements_due'
  | 'business.created'
  | 'business.published'
  | 'business.paused_guardian'
  | 'subscription.created'
  | 'subscription.activated'
  | 'subscription.canceled'
  | 'occurrence.completed'
  | 'occurrence.provider_skipped'
  | 'occurrence.customer_skipped'
  | 'occurrence.credited'
  | 'occurrence.issue_reported'
  | 'occurrence.canceled'
  | 'ledger.credit_written'
  | 'subscription.cycle_settled'
  | 'subscription.payment_failed'
  | 'subscription.paused'
  | 'subscription.resumed'
  | 'review.reported'
  | 'review.hidden'
  | 'review.removed'
  | 'message.blocked'
  | 'message.reported'
  | 'message.redacted'
  | 'incident.opened'
  | 'incident.resolved'
  | 'payout.hold_placed'
  | 'payout.hold_released'
  | 'address.accessed_by_staff'
  | 'service.created'
  | 'service.wording_refused'
  | 'service.area_set'
  | 'service.state_changed'
  | 'guardian.category_approved'
  | 'guardian.category_revoked'
  | 'account.suspended'
  | 'role.granted'
  | 'referral.attached'
  | 'referral.bonus_paid'
  | 'referral.voided'
  | 'consent.signed'
  | 'consent.revoked'
  | 'listing.made_public'
  | 'listing.made_private'
  | 'refund.issued'
  | 'account.reinstated'
  | 'photo.viewed_by_staff'
  | 'payout.sent'
  | 'account.closed'
  | 'account.de_identified'
  | 'account.retired_dormant'
  | 'jurisdiction.blocked'
  | 'jurisdiction.allowed'
  | 'jurisdiction.lifted'
  | 'jurisdiction.posture_changed'

/** Fields that must never appear in an audit snapshot. */
const REDACTED_KEYS = new Set([
  'date_of_birth',
  'dateOfBirth',
  'dob',
  'password',
  'access_code',
  'gate_code',
  'ssn',
  'invitation_email',
  'invitation_phone',
  'email',
  'phone',
  'phone_e164',
  'address',
  'street',
])

export function redactSnapshot(input: unknown): unknown {
  if (input === null || typeof input !== 'object') return input
  if (Array.isArray(input)) return input.map(redactSnapshot)
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    out[k] = REDACTED_KEYS.has(k) ? '[redacted]' : redactSnapshot(v)
  }
  return out
}

export function hashIp(ip: string | null | undefined): string | null {
  if (!ip) return null
  return createHash('sha256').update(serverEnv().AUDIT_IP_HASH_SALT).update(ip).digest('hex')
}

export type AuditEntry = {
  actorUserId: string | null
  actorRole: string | null
  action: AuditAction
  targetType: string
  targetId: string
  before?: unknown
  after?: unknown
  reasonCode?: string | null
  ip?: string | null
}

/**
 * Writes one audit row. Uses the privileged client because the log is
 * append-only and deliberately not readable or writable through the normal
 * user-scoped policies.
 *
 * Never throws into the caller's path: a failed audit write must be loud in
 * the logs but must not, for example, roll back a guardian revocation. A
 * revocation that happened is safer than a revocation undone because its
 * bookkeeping failed.
 */
export async function writeAudit(entry: AuditEntry): Promise<void> {
  try {
    const { error } = await supabaseAdmin()
      .from('audit_log')
      .insert({
        actor_user_id: entry.actorUserId,
        actor_role: entry.actorRole,
        action: entry.action,
        target_type: entry.targetType,
        target_id: entry.targetId,
        before_json: entry.before === undefined ? null : redactSnapshot(entry.before),
        after_json: entry.after === undefined ? null : redactSnapshot(entry.after),
        reason_code: entry.reasonCode ?? null,
        ip_hash: hashIp(entry.ip),
      })
    if (error) console.error('[audit] write failed', { action: entry.action, error: error.message })
  } catch (err) {
    console.error('[audit] write threw', { action: entry.action, err })
  }
}
