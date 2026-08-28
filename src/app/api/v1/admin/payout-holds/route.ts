/**
 * POST   /v1/admin/payout-holds   place a hold
 * DELETE /v1/admin/payout-holds   release one
 *
 * Holding a provider's payouts stops money reaching them while something
 * is looked into. Both directions need a written reason of real length --
 * see checkReason -- because the person reading this later is deciding
 * whether a teenager was treated fairly, and "fraud?" tells them nothing.
 *
 * Separation of duties is enforced in the role model rather than here: a
 * trust_safety_agent can hold payouts and cannot release them. That is
 * deliberate and there is a test asserting it.
 */

import { authenticate, clientIp } from '@/server/auth'
import { holdPayouts, releasePayouts } from '@/server/adminService'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { apiError, apiOk, newRequestId } from '@/lib/http'

export const dynamic = 'force-dynamic'

type Body = { providerUserId?: string; reason?: unknown; incidentId?: string }

async function readBody(request: Request): Promise<Body | null> {
  try {
    return (await request.json()) as Body
  } catch {
    return null
  }
}

export async function POST(request: Request): Promise<Response> {
  const requestId = newRequestId()

  const auth = await authenticate()
  if (!auth.ok) return apiError('UNAUTHENTICATED', 'Sign in to continue.', 401, { requestId })

  const body = await readBody(request)
  if (!body?.providerUserId) {
    return apiError('VALIDATION_FAILED', 'Which provider?', 400, { requestId })
  }

  const result = await holdPayouts({
    db: supabaseAdmin(),
    actor: { userId: auth.auth.userId, roles: auth.auth.roles, ip: clientIp(request) },
    providerUserId: body.providerUserId,
    ...(body.incidentId ? { incidentId: body.incidentId } : {}),
    reason: body.reason,
  })

  if (!result.ok) {
    if (result.code === 'NOT_AUTHORIZED') return new Response(null, { status: 404 })
    return apiError(result.code, result.message, result.code === 'REASON_REQUIRED' ? 400 : 409, {
      requestId,
    })
  }

  return apiOk({ providerUserId: body.providerUserId, held: true })
}

export async function DELETE(request: Request): Promise<Response> {
  const requestId = newRequestId()

  const auth = await authenticate()
  if (!auth.ok) return apiError('UNAUTHENTICATED', 'Sign in to continue.', 401, { requestId })

  const body = await readBody(request)
  if (!body?.providerUserId) {
    return apiError('VALIDATION_FAILED', 'Which provider?', 400, { requestId })
  }

  const result = await releasePayouts({
    db: supabaseAdmin(),
    actor: { userId: auth.auth.userId, roles: auth.auth.roles, ip: clientIp(request) },
    providerUserId: body.providerUserId,
    reason: body.reason,
    now: new Date(),
  })

  if (!result.ok) {
    if (result.code === 'NOT_AUTHORIZED') return new Response(null, { status: 404 })
    return apiError(result.code, result.message, result.code === 'REASON_REQUIRED' ? 400 : 409, {
      requestId,
    })
  }

  return apiOk({ providerUserId: body.providerUserId, held: false })
}
