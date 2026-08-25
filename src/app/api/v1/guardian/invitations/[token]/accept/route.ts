/**
 * POST /v1/guardian/invitations/{token}/accept
 *
 * API_CONTRACT: "Guardian accepts relationship and begins verification /
 * payment representative workflow."
 *
 * The guardian must be signed in, but they are not yet linked to the
 * provider, so the lookup runs through the privileged client. Authorization
 * is possession of the token plus a session -- which is why the token is
 * high-entropy, hashed at rest, single-use, and expiring.
 */

import { authenticate, clientIp } from '@/server/auth'
import { acceptGuardianInvitation } from '@/server/guardianService'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { apiError, apiOk, newRequestId } from '@/lib/http'

export async function POST(
  req: Request,
  ctx: { params: Promise<{ token: string }> },
): Promise<Response> {
  const requestId = newRequestId()

  const auth = await authenticate()
  if (!auth.ok) {
    return apiError('UNAUTHENTICATED', 'Sign in to accept this invitation.', 401, { requestId })
  }

  const { token } = await ctx.params
  if (!token || token.length < 20) {
    // Same shape as a genuine miss: a malformed token must not be
    // distinguishable from a valid-looking one that does not exist.
    return apiError('INVALID_TOKEN', 'This invitation link is not valid.', 404, { requestId })
  }

  const result = await acceptGuardianInvitation({
    adminDb: supabaseAdmin(),
    token,
    guardianUserId: auth.auth.userId,
    now: new Date(),
    ip: clientIp(req),
  })

  if (!result.ok) {
    switch (result.code) {
      case 'INVALID_TOKEN':
        return apiError(result.code, 'This invitation link is not valid.', 404, { requestId })
      case 'INVITATION_EXPIRED':
        return apiError(result.code, 'This invitation has expired. Ask for a new one.', 410, {
          requestId,
        })
      case 'ILLEGAL_GUARDIAN_TRANSITION':
        return apiError(result.code, 'This invitation can no longer be accepted.', 409, {
          requestId,
        })
      default:
        return apiError('INTERNAL_ERROR', 'Something went wrong. Please try again.', 500, {
          requestId,
        })
    }
  }

  return apiOk({
    relationshipId: result.relationshipId,
    state: result.state,
    nextStage: 'guardian_verification',
  })
}
