/**
 * Recording and revoking signed consents.
 *
 * ## Signing the guardian consent is what verifies the relationship
 *
 * `VERIFY` existed in the guardian state machine and nothing fired it, so
 * no guardian could reach `verified` and therefore no minor could ever take
 * a paying customer. The legal pass asked to "extend the existing guardian
 * verified state to capture the artifact itself, not just a boolean" -- so
 * the artifact is the event. A relationship becomes verified because a
 * consent was signed, and the row proving it is written first.
 *
 * ## What verification_method is allowed to say
 *
 * At signature time the signer has a confirmed email address and an
 * authenticated session. That is what gets recorded, in those words. It is
 * NOT an identity check, and writing anything stronger here would put a
 * claim in the legal record that the product cannot support -- the same
 * rule the trust badges follow.
 *
 * Stripe's KYC happens later, at payout onboarding, and is a different
 * fact about a different moment.
 *
 * ## Order of writes
 *
 * The consent row goes in before the state changes. A crash between them
 * leaves a signed consent against a relationship that has not moved yet,
 * which the guardian can resolve by signing again -- the second signature
 * is a second valid record, and consent given twice is not a problem.
 * The reverse would leave a verified relationship with nothing backing it,
 * which is exactly the thing this whole change exists to prevent.
 */

import { createHash } from 'node:crypto'
import {
  canonicalText,
  checkAcknowledgements,
  checkTypedSignature,
  CONSENT_DOCUMENTS,
  type ConsentKind,
} from '@/domain/consent'
import { transition } from '@/domain/guardian'
import { writeAudit } from '@/server/audit'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'

type Db = SupabaseClient<Database>

/** What we are willing to claim about who signed. */
export const VERIFICATION_AUTHENTICATED_SESSION = 'authenticated_session'

export function documentHash(kind: ConsentKind): string {
  return createHash('sha256').update(canonicalText(CONSENT_DOCUMENTS[kind]), 'utf8').digest('hex')
}

export type RecordConsentResult =
  | { ok: true; consentId: string; guardianState?: string }
  | {
      ok: false
      code: 'INCOMPLETE' | 'BAD_SIGNATURE' | 'NO_RELATIONSHIP' | 'ILLEGAL_TRANSITION' | 'WRITE_FAILED'
      message: string
      missing?: string[]
    }

export async function recordConsent(args: {
  db: Db
  kind: ConsentKind
  signerUserId: string
  /** The minor. Required for guardian consents, absent for a customer. */
  subjectUserId?: string | undefined
  subscriptionId?: string | undefined
  acknowledgedItems: readonly string[]
  typedName: unknown
  ipHash?: string | null
  userAgent?: string | null
}): Promise<RecordConsentResult> {
  const doc = CONSENT_DOCUMENTS[args.kind]

  const acknowledged = checkAcknowledgements(doc, args.acknowledgedItems)
  if (!acknowledged.ok) {
    return { ok: false, code: 'INCOMPLETE', message: acknowledged.message, missing: acknowledged.missing }
  }

  const signature = checkTypedSignature(args.typedName)
  if (!signature.ok) return { ok: false, code: 'BAD_SIGNATURE', message: signature.message }

  const { data: row, error } = await args.db
    .from('consent_records')
    .insert({
      kind: args.kind,
      signer_user_id: args.signerUserId,
      subject_user_id: args.subjectUserId ?? null,
      subscription_id: args.subscriptionId ?? null,
      document_version: doc.version,
      document_hash: documentHash(args.kind),
      // Stored as well as hashed. A hash proves a match; it does not let a
      // person read what was agreed to three years from now, and that is
      // the point of keeping the record.
      document_text: canonicalText(doc),
      acknowledged_items: [...args.acknowledgedItems],
      typed_name: signature.name,
      verification_method: VERIFICATION_AUTHENTICATED_SESSION,
      ip_hash: args.ipHash ?? null,
      user_agent: args.userAgent ?? null,
    })
    .select('id')
    .single()

  if (error || !row) {
    console.error('[consent] write failed', error?.message)
    return { ok: false, code: 'WRITE_FAILED', message: 'We could not save that. Please try again.' }
  }

  await writeAudit({
    actorUserId: args.signerUserId,
    actorRole: args.kind === 'customer_attestation' ? 'customer' : 'guardian',
    action: 'consent.signed',
    targetType: 'consent_record',
    targetId: row.id,
    // The acknowledged keys, not the text. The text is on the record.
    after: {
      kind: args.kind,
      document_version: doc.version,
      acknowledged: args.acknowledgedItems.length,
    },
  })

  if (args.kind === 'guardian_consent' && args.subjectUserId) {
    const verified = await verifyRelationship({
      db: args.db,
      providerUserId: args.subjectUserId,
      guardianUserId: args.signerUserId,
      consentId: row.id,
    })
    if (!verified.ok) return verified
    return { ok: true, consentId: row.id, guardianState: verified.state }
  }

  return { ok: true, consentId: row.id }
}

/**
 * Moves the relationship to verified, because a consent now backs it.
 *
 * Scoped to the signer's own relationship: a guardian cannot verify a
 * relationship they are not party to, whatever subject id they send.
 */
async function verifyRelationship(args: {
  db: Db
  providerUserId: string
  guardianUserId: string
  consentId: string
}): Promise<{ ok: true; state: string } | Extract<RecordConsentResult, { ok: false }>> {
  const { data: rel } = await args.db
    .from('guardian_relationships')
    .select('id, state')
    .eq('provider_user_id', args.providerUserId)
    .eq('guardian_user_id', args.guardianUserId)
    .maybeSingle()

  if (!rel) {
    return { ok: false, code: 'NO_RELATIONSHIP', message: 'No guardian relationship to confirm.' }
  }

  const moved = transition(rel.state as never, 'VERIFY')
  if (!moved.ok) {
    return {
      ok: false,
      code: 'ILLEGAL_TRANSITION',
      message: 'This relationship cannot be confirmed from its current state.',
    }
  }

  const { error } = await args.db
    .from('guardian_relationships')
    .update({ state: moved.to, consented_at: new Date().toISOString() })
    .eq('id', rel.id)
    .eq('state', rel.state)

  if (error) {
    console.error('[consent] relationship verify failed', error.message)
    return { ok: false, code: 'WRITE_FAILED', message: 'We could not save that. Please try again.' }
  }

  await args.db
    .from('provider_profiles')
    .update({ guardian_state: moved.to })
    .eq('user_id', args.providerUserId)

  await writeAudit({
    actorUserId: args.guardianUserId,
    actorRole: 'guardian',
    action: 'guardian.verified',
    targetType: 'guardian_relationship',
    targetId: rel.id,
    before: { state: rel.state },
    after: { state: moved.to, consent_record_id: args.consentId },
  })

  return { ok: true, state: moved.to }
}

/**
 * The active consent of a kind, or null.
 *
 * "Active" means signed and not revoked. Revocations are separate rows
 * pointing back, so this reads both and subtracts -- there is no flag on
 * the original to trust or to have forgotten to set.
 */
export async function activeConsent(args: {
  db: Db
  kind: ConsentKind
  signerUserId?: string | undefined
  subjectUserId?: string | undefined
}): Promise<{ id: string; documentVersion: string; signedAt: string } | null> {
  let query = args.db
    .from('consent_records')
    .select('id, document_version, signed_at, revokes_id')
    .eq('kind', args.kind)
    .order('signed_at', { ascending: false })

  if (args.signerUserId) query = query.eq('signer_user_id', args.signerUserId)
  if (args.subjectUserId) query = query.eq('subject_user_id', args.subjectUserId)

  const { data } = await query
  const rows = data ?? []

  const revoked = new Set(rows.filter((r) => r.revokes_id).map((r) => r.revokes_id as string))
  const live = rows.find((r) => !r.revokes_id && !revoked.has(r.id))

  return live
    ? { id: live.id, documentVersion: live.document_version, signedAt: live.signed_at }
    : null
}

export type RevokeResult =
  | { ok: true; revocationId: string }
  | { ok: false; code: 'NOT_FOUND' | 'NOT_YOURS' | 'WRITE_FAILED'; message: string }

/**
 * Withdraws a consent by writing a revocation row.
 *
 * Never an update. The original signature stays exactly as it was signed,
 * which is what makes the record worth keeping.
 */
export async function revokeConsent(args: {
  db: Db
  consentId: string
  actorUserId: string
  reason: string
}): Promise<RevokeResult> {
  const { data: original } = await args.db
    .from('consent_records')
    .select('id, kind, signer_user_id, subject_user_id, document_version, document_hash, document_text, acknowledged_items, typed_name')
    .eq('id', args.consentId)
    .maybeSingle()

  if (!original) return { ok: false, code: 'NOT_FOUND', message: 'No such consent.' }
  if (original.signer_user_id !== args.actorUserId) {
    return { ok: false, code: 'NOT_YOURS', message: 'Only the person who signed this can withdraw it.' }
  }

  const { data: row, error } = await args.db
    .from('consent_records')
    .insert({
      kind: original.kind,
      signer_user_id: original.signer_user_id,
      subject_user_id: original.subject_user_id,
      document_version: original.document_version,
      document_hash: original.document_hash,
      document_text: original.document_text,
      acknowledged_items: original.acknowledged_items,
      typed_name: original.typed_name,
      verification_method: VERIFICATION_AUTHENTICATED_SESSION,
      revokes_id: original.id,
      revocation_reason: args.reason,
    })
    .select('id')
    .single()

  if (error || !row) {
    console.error('[consent] revocation write failed', error?.message)
    return { ok: false, code: 'WRITE_FAILED', message: 'We could not save that. Please try again.' }
  }

  await writeAudit({
    actorUserId: args.actorUserId,
    actorRole: 'guardian',
    action: 'consent.revoked',
    targetType: 'consent_record',
    targetId: original.id,
    after: { revocation_id: row.id, kind: original.kind },
    reasonCode: 'guardian_request',
  })

  return { ok: true, revocationId: row.id }
}
