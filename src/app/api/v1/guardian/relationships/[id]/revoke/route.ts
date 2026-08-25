/**
 * POST /v1/guardian/relationships/{id}/revoke
 *
 * API_CONTRACT: "Revokes consent and triggers business pause policy."
 *
 * QA_ACCEPTANCE section 3 requires that revocation immediately prevents new
 * checkout and stops future charges. Both are satisfied by writing the
 * state: domain/gates.ts reads guardian state live on every publish and
 * checkout attempt, so there is no cache to invalidate.
 */

import { authenticate, clientIp } from '@/server/auth'
import { revokeGuardianRelationship } from '@/server/guardianService'
import { hasPermission } from '@/domain/roles'
import { apiError, apiOk, newRequestId } from '@/lib/http'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { z } from 'zod'

const revokeSchema = z.object({
  reasonCode: z.string().trim().max(64).optional(),
})

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = newRequestId()

  const auth = await authenticate()
  if (!auth.ok) {
    return apiError('UNAUTHENTICATED', 'Sign in to continue.', 401, { requestId })
  }

  // Trust and safety may revoke any relationship; a guardian may revoke
  // only their own, which guardianService verifies against the row.
  const isStaff = hasPermission(auth.auth.roles, 'moderation:act')
  const isGuardian = hasPermission(auth.auth.roles, 'guardian:revoke')
  if (!isStaff && !isGuardian) {
    return apiError('NOT_AUTHORIZED', 'This account cannot perform that action.', 403, { requestId })
  }

  let body: unknown = {}
  try {
    const text = await req.text()
    if (text) body = JSON.parse(text)
  } catch {
    return apiError('INVALID_JSON', 'Request body must be JSON.', 400, { requestId })
  }

  const parsed = revokeSchema.safeParse(body)
  if (!parsed.success) {
    return apiError('VALIDATION_FAILED', 'Check the highlighted fields.', 400, { requestId })
  }

  const { id } = await ctx.params

  const result = await revokeGuardianRelationship({
    // Privileged client; guardianService checks that the actor is party to
    // the relationship before transitioning it.
    db: supabaseAdmin(),
    relationshipId: id,
    actorUserId: auth.auth.userId,
    actorRole: isStaff && !isGuardian ? 'trust_safety_agent' : 'guardian',
    reasonCode: parsed.data.reasonCode ?? null,
    now: new Date(),
    ip: clientIp(req),
  })

  if (!result.ok) {
    switch (result.code) {
      case 'NOT_FOUND':
      case 'NOT_AUTHORIZED':
        // Collapsed on purpose: revealing that a relationship exists but
        // belongs to someone else is itself a disclosure.
        return apiError('NOT_FOUND', 'That relationship was not found.', 404, { requestId })
      case 'ILLEGAL_GUARDIAN_TRANSITION':
        return apiError(result.code, 'This relationship cannot be revoked in its current state.', 409, {
          requestId,
        })
      default:
        return apiError('INTERNAL_ERROR', 'Something went wrong. Please try again.', 500, {
          requestId,
        })
    }
  }

  return apiOk({ relationshipId: result.relationshipId, state: result.state })
}
