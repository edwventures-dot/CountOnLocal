/**
 * POST /v1/admin/account-actions
 *
 * Strike, suspend, ban, reinstate. The only consequences the product has,
 * by decision: no monetary penalties on users, ever. The provider is
 * frequently a fourteen-year-old whose payout account we hold, and fining
 * them over a missed collection would be taking money from a child.
 *
 * A strike needs moderation:act. Everything else needs account:suspend,
 * which is a narrower role -- taking somebody's livelihood away is a
 * different decision from noting that something went wrong.
 */

import { authenticate, clientIp } from '@/server/auth'
import { applyAccountAction } from '@/server/disputeService'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { apiError, apiOk, newRequestId } from '@/lib/http'

export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  const requestId = newRequestId()

  const auth = await authenticate()
  if (!auth.ok) return apiError('UNAUTHENTICATED', 'Sign in to continue.', 401, { requestId })

  let body: { subjectUserId?: string; kind?: unknown; reason?: unknown; incidentId?: string }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return apiError('INVALID_JSON', 'Request body must be JSON.', 400, { requestId })
  }

  if (!body.subjectUserId) {
    return apiError('VALIDATION_FAILED', 'Which account?', 400, { requestId })
  }

  const result = await applyAccountAction({
    db: supabaseAdmin(),
    actor: { userId: auth.auth.userId, roles: auth.auth.roles, ip: clientIp(request) },
    subjectUserId: body.subjectUserId,
    kind: body.kind,
    reason: body.reason,
    ...(body.incidentId ? { incidentId: body.incidentId } : {}),
  })

  if (!result.ok) {
    if (result.code === 'NOT_AUTHORIZED') return new Response(null, { status: 404 })
    return apiError(result.code, result.message, result.code === 'WRITE_FAILED' ? 500 : 422, {
      requestId,
    })
  }

  return apiOk({
    subjectUserId: body.subjectUserId,
    standing: result.standing,
  })
}
