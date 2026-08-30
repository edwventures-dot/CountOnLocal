/**
 * POST /api/v1/admin/undelivered   requeue mail the outbox gave up on
 *
 * The list itself is rendered server-side in the console; only the retry
 * needs an endpoint.
 *
 * 404 rather than 403 without the permission, matching the rest of the
 * admin surface: a 403 confirms this exists.
 */

import { authenticate, clientIp } from '@/server/auth'
import { hasPermission } from '@/domain/roles'
import { retryUndelivered } from '@/server/undeliveredMail'
import { writeAudit } from '@/server/audit'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { apiError, apiOk, newRequestId } from '@/lib/http'

export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  const requestId = newRequestId()

  const auth = await authenticate()
  if (!auth.ok) return new Response(null, { status: 404 })
  if (!hasPermission(auth.auth.roles, 'incident:manage')) {
    return new Response(null, { status: 404 })
  }

  let payload: { ids?: unknown }
  try {
    payload = (await request.json()) as typeof payload
  } catch {
    return apiError('INVALID_BODY', 'Send a JSON body.', 400, { requestId })
  }

  const ids = Array.isArray(payload.ids)
    ? payload.ids.filter((v): v is string => typeof v === 'string')
    : []

  if (ids.length === 0) {
    return apiError('VALIDATION_FAILED', 'Nothing to requeue.', 422, { requestId })
  }

  const result = await retryUndelivered({ db: supabaseAdmin(), ids, now: new Date() })
  if (!result.ok) return apiError(result.code, result.message, 500, { requestId })

  await writeAudit({
    actorUserId: auth.auth.userId,
    actorRole: auth.auth.roles.join(','),
    action: 'mail.requeued',
    targetType: 'notification',
    // The batch, not one row: the audit answers "who retried mail and
    // when", and a row per id would bury that in noise.
    targetId: ids[0]!,
    after: { requeued: result.queued, ids },
    reasonCode: 'undelivered_retry',
    ip: clientIp(request),
  })

  return apiOk({ requestId, queued: result.queued })
}
