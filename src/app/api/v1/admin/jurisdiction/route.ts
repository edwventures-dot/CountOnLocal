/**
 * POST   /api/v1/admin/jurisdiction   close or clear a state
 * PATCH  /api/v1/admin/jurisdiction   lift a live rule, or change the posture
 *
 * The handle on the lever built in migration 0040. Without it, counsel's
 * answer to "which states must wait" could only be applied by writing SQL
 * against production by hand — which is not a supported path, leaves no
 * audit row, and is the kind of gap that stays open for a year.
 *
 * 404 rather than 403 for a caller without the permission, matching the
 * rest of the admin console: a 403 confirms this endpoint exists.
 */

import { authenticate, clientIp } from '@/server/auth'
import { hasPermission } from '@/domain/roles'
import {
  liftJurisdictionRule,
  setJurisdictionRule,
  setPosture,
} from '@/server/jurisdictionAdmin'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { apiError, apiOk, newRequestId } from '@/lib/http'

export const dynamic = 'force-dynamic'

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export async function POST(request: Request): Promise<Response> {
  const requestId = newRequestId()

  const auth = await authenticate()
  if (!auth.ok) return new Response(null, { status: 404 })
  if (!hasPermission(auth.auth.roles, 'incident:manage')) {
    return new Response(null, { status: 404 })
  }

  let payload: Record<string, unknown> = {}
  try {
    payload = (await request.json()) as Record<string, unknown>
  } catch {
    return apiError('INVALID_BODY', 'Send a JSON body.', 400, { requestId })
  }

  const status = str(payload['status'])
  if (status !== 'blocked' && status !== 'allowed') {
    return apiError('INVALID_BODY', 'status must be blocked or allowed.', 422, { requestId })
  }

  const catalogCode = str(payload['catalogCode']).trim()

  const result = await setJurisdictionRule({
    db: supabaseAdmin(),
    actorUserId: auth.auth.userId,
    actorRoles: auth.auth.roles,
    region: str(payload['region']),
    status,
    ...(catalogCode ? { catalogCode } : {}),
    reason: str(payload['reason']),
    ip: clientIp(request) ?? undefined,
  })

  if (!result.ok) {
    const code = result.code === 'NOT_AUTHORIZED' ? 404 : result.code === 'ALREADY_SET' ? 409 : 422
    if (code === 404) return new Response(null, { status: 404 })
    return apiError(result.code, result.message, code, { requestId })
  }

  return apiOk({ requestId, id: result.id }, 201)
}

export async function PATCH(request: Request): Promise<Response> {
  const requestId = newRequestId()

  const auth = await authenticate()
  if (!auth.ok) return new Response(null, { status: 404 })
  if (!hasPermission(auth.auth.roles, 'incident:manage')) {
    return new Response(null, { status: 404 })
  }

  let payload: Record<string, unknown> = {}
  try {
    payload = (await request.json()) as Record<string, unknown>
  } catch {
    return apiError('INVALID_BODY', 'Send a JSON body.', 400, { requestId })
  }

  const db = supabaseAdmin()
  const common = {
    db,
    actorUserId: auth.auth.userId,
    actorRoles: auth.auth.roles,
    reason: str(payload['reason']),
    now: new Date(),
    ip: clientIp(request) ?? undefined,
  }

  const posture = str(payload['posture'])
  const result =
    posture === 'open' || posture === 'allowlist'
      ? await setPosture({ ...common, posture })
      : await liftJurisdictionRule({ ...common, ruleId: str(payload['ruleId']) })

  if (!result.ok) {
    if (result.code === 'NOT_AUTHORIZED') return new Response(null, { status: 404 })
    return apiError(result.code, result.message, result.code === 'NOT_FOUND' ? 404 : 422, {
      requestId,
    })
  }

  return apiOk({ requestId, id: result.id })
}
