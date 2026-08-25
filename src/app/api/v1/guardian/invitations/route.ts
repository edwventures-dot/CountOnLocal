/**
 * POST /v1/guardian/invitations
 *
 * API_CONTRACT: "Provider creates guardian invitation."
 *
 * The raw token is returned once so the notification worker can deliver it.
 * It is deliberately not logged and not persisted -- only its hash is
 * stored. Once the outbox from TECHNICAL_SPEC section 12 exists, this
 * handler should hand the token straight to it and stop returning it to the
 * browser at all.
 */

import { authenticate, clientIp } from '@/server/auth'
import { createGuardianInvitation, inviteSchema } from '@/server/guardianService'
import { hasPermission } from '@/domain/roles'
import { apiError, apiOk, newRequestId } from '@/lib/http'
import { supabaseAdmin } from '@/lib/supabase/admin'

export async function POST(req: Request): Promise<Response> {
  const requestId = newRequestId()

  const auth = await authenticate()
  if (!auth.ok) {
    return apiError('UNAUTHENTICATED', 'Sign in to continue.', 401, { requestId })
  }

  if (!hasPermission(auth.auth.roles, 'guardian:invite')) {
    return apiError('NOT_AUTHORIZED', 'This account cannot perform that action.', 403, { requestId })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return apiError('INVALID_JSON', 'Request body must be JSON.', 400, { requestId })
  }

  const parsed = inviteSchema.safeParse(body)
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {}
    for (const issue of parsed.error.issues) {
      fieldErrors[issue.path.join('.') || 'body'] = issue.message
    }
    return apiError('VALIDATION_FAILED', 'Check the highlighted fields.', 400, {
      requestId,
      fieldErrors,
    })
  }

  const result = await createGuardianInvitation({
    db: supabaseAdmin(),
    // From the verified session, never the request body.
    providerUserId: auth.auth.userId,
    input: parsed.data,
    now: new Date(),
    ip: clientIp(req),
  })

  if (!result.ok) {
    if (result.code === 'NO_PROVIDER_PROFILE') {
      return apiError(result.code, 'Complete provider onboarding first.', 409, { requestId })
    }
    if (result.code === 'ILLEGAL_GUARDIAN_TRANSITION') {
      return apiError(result.code, 'A guardian invitation cannot be sent right now.', 409, {
        requestId,
      })
    }
    return apiError('INTERNAL_ERROR', 'Something went wrong. Please try again.', 500, { requestId })
  }

  return apiOk(
    {
      relationshipId: result.relationshipId,
      state: result.state,
      expiresAt: result.expiresAt,
      invitationToken: result.token,
    },
    201,
  )
}
