/**
 * POST /v1/guardian/consents
 *
 * Signs one of the guardian consent documents. Signing the base guardian
 * consent is what moves the relationship to `verified` -- the artifact is
 * the event, not a boolean somebody sets afterwards.
 *
 * The subject is read from the caller's own relationship rather than from
 * the body, so a guardian cannot sign a consent about a minor they are not
 * responsible for by sending a different id.
 */

import { authenticate, clientIp } from '@/server/auth'
import { recordConsent } from '@/server/consentService'
import { hashIp } from '@/server/audit'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { apiError, apiOk, newRequestId } from '@/lib/http'
import type { ConsentKind } from '@/domain/consent'

export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  const requestId = newRequestId()

  const auth = await authenticate()
  if (!auth.ok) return apiError('UNAUTHENTICATED', 'Sign in to continue.', 401, { requestId })

  let body: { kind?: string; acknowledgedItems?: unknown; typedName?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return apiError('INVALID_JSON', 'Request body must be JSON.', 400, { requestId })
  }

  const kind = body.kind
  if (kind !== 'guardian_consent' && kind !== 'public_listing_consent') {
    return apiError('VALIDATION_FAILED', 'Unknown consent.', 400, { requestId })
  }

  const db = supabaseAdmin()

  // The minor comes from the relationship, never from the request.
  const { data: rel } = await db
    .from('guardian_relationships')
    .select('provider_user_id, state')
    .eq('guardian_user_id', auth.auth.userId)
    .not('state', 'in', '(revoked,expired)')
    .maybeSingle()

  if (!rel) {
    return apiError('NO_RELATIONSHIP', 'You are not the guardian for anyone here.', 404, {
      requestId,
    })
  }

  const result = await recordConsent({
    db,
    kind: kind as ConsentKind,
    signerUserId: auth.auth.userId,
    subjectUserId: rel.provider_user_id,
    acknowledgedItems: Array.isArray(body.acknowledgedItems)
      ? (body.acknowledgedItems as string[])
      : [],
    typedName: body.typedName,
    ipHash: hashIp(clientIp(request)),
  })

  if (!result.ok) {
    const status = result.code === 'NO_RELATIONSHIP' ? 404 : result.code === 'WRITE_FAILED' ? 500 : 422
    return apiError(result.code, result.message, status, {
      requestId,
      ...(result.missing ? { fieldErrors: { acknowledgedItems: result.missing.join(', ') } } : {}),
    })
  }

  // A public listing consent is only meaningful once it is attached to the
  // business it makes findable.
  if (kind === 'public_listing_consent') {
    const { data: business } = await db
      .from('businesses')
      .select('id, state')
      .eq('provider_user_id', rel.provider_user_id)
      .neq('state', 'closed')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (business) {
      await db
        .from('businesses')
        .update({ public_listing_consent_id: result.consentId, searchable: true })
        .eq('id', business.id)
    }
  }

  return apiOk(
    {
      consentId: result.consentId,
      ...(result.guardianState ? { guardianState: result.guardianState } : {}),
    },
    201,
  )
}
