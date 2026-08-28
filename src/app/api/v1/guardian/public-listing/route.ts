/**
 * DELETE /v1/guardian/public-listing
 *
 * Withdraws the Public Listing Consent. The listing stops being findable
 * immediately; the direct link and the QR code keep working, which is the
 * whole distinction the default-private model rests on.
 *
 * The consent record is not edited -- a revocation row is written and the
 * business stops pointing at the original. What was signed stays exactly
 * as signed.
 */

import { authenticate } from '@/server/auth'
import { revokeConsent } from '@/server/consentService'
import { writeAudit } from '@/server/audit'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { apiError, apiOk, newRequestId } from '@/lib/http'

export const dynamic = 'force-dynamic'

export async function DELETE(): Promise<Response> {
  const requestId = newRequestId()

  const auth = await authenticate()
  if (!auth.ok) return apiError('UNAUTHENTICATED', 'Sign in to continue.', 401, { requestId })

  const db = supabaseAdmin()

  const { data: rel } = await db
    .from('guardian_relationships')
    .select('provider_user_id')
    .eq('guardian_user_id', auth.auth.userId)
    .not('state', 'in', '(revoked,expired)')
    .maybeSingle()

  if (!rel) {
    return apiError('NO_RELATIONSHIP', 'You are not the guardian for anyone here.', 404, {
      requestId,
    })
  }

  const { data: business } = await db
    .from('businesses')
    .select('id, public_listing_consent_id')
    .eq('provider_user_id', rel.provider_user_id)
    .not('public_listing_consent_id', 'is', null)
    .maybeSingle()

  if (!business?.public_listing_consent_id) {
    return apiError('NOT_PUBLIC', 'That listing is already private.', 409, { requestId })
  }

  const revoked = await revokeConsent({
    db,
    consentId: business.public_listing_consent_id,
    actorUserId: auth.auth.userId,
    reason: 'guardian withdrew the public listing consent',
  })

  if (!revoked.ok) {
    return apiError(revoked.code, revoked.message, revoked.code === 'NOT_FOUND' ? 404 : 500, {
      requestId,
    })
  }

  // Stop being findable first and worry about tidiness second.
  const { error } = await db
    .from('businesses')
    .update({ searchable: false, public_listing_consent_id: null })
    .eq('id', business.id)

  if (error) {
    console.error('[listing] could not make private after revocation', error.message)
    return apiError('WRITE_FAILED', 'We could not update the listing. Please try again.', 500, {
      requestId,
    })
  }

  await writeAudit({
    actorUserId: auth.auth.userId,
    actorRole: 'guardian',
    action: 'listing.made_private',
    targetType: 'business',
    targetId: business.id,
    after: { searchable: false, revocation_id: revoked.revocationId },
    reasonCode: 'guardian_request',
  })

  return apiOk({ businessId: business.id, searchable: false })
}
