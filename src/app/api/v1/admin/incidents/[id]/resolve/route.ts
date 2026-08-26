/**
 * POST /v1/admin/incidents/{id}/resolve
 *
 * PRD section 24: staff actions need a permission and a recorded reason.
 * The resolution IS the reason here -- it goes in the audit log and on the
 * incident, and a resolution nobody can read is a resolution that did not
 * explain anything.
 *
 * The reason is checked before the state changes, so an incident resolved
 * without one is not an incident with a missing note. It is an incident
 * that is still open.
 */

import { authenticate, clientIp } from '@/server/auth'
import { resolveIncident } from '@/server/adminService'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { apiError, apiOk, newRequestId } from '@/lib/http'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

export async function POST(request: Request, { params }: Params): Promise<Response> {
  const requestId = newRequestId()

  const auth = await authenticate()
  if (!auth.ok) return apiError('UNAUTHENTICATED', 'Sign in to continue.', 401, { requestId })

  const { id } = await params

  let payload: { resolution?: unknown }
  try {
    payload = (await request.json()) as typeof payload
  } catch {
    return apiError('INVALID_BODY', 'Send a JSON body.', 400, { requestId })
  }

  const result = await resolveIncident({
    db: supabaseAdmin(),
    actor: { userId: auth.auth.userId, roles: auth.auth.roles, ip: clientIp(request) },
    incidentId: id,
    resolution: payload.resolution,
    now: new Date(),
  })

  if (!result.ok) {
    const status =
      result.code === 'NOT_AUTHORIZED'
        ? 403
        : result.code === 'NOT_FOUND'
          ? 404
          : result.code === 'REASON_REQUIRED'
            ? 422
            : 500
    return apiError(result.code, result.message, status, { requestId })
  }

  return apiOk({ incidentId: id, state: 'resolved' })
}
