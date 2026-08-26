/**
 * POST /v1/incidents   file a safety report
 * GET  /v1/incidents   the staff queue
 *
 * SAFETY_TRUST_POLICY section 15.
 *
 * Filing is open to any signed-in user, deliberately. The person who most
 * needs to file a report is the person it happened to, and putting a staff
 * permission in front of that would mean somebody reporting a threat has to
 * find a support email first.
 *
 * Reading the queue is not. It contains reporters' accounts of things that
 * may involve a child.
 *
 * Severity is set from the category, never from the request. Somebody in
 * distress should not have to pick the right number for their report to be
 * seen quickly, and taking it from the body would let anybody mark their
 * own complaint an emergency.
 */

import { authenticate, clientIp } from '@/server/auth'
import { incidentQueue, openIncident } from '@/server/adminService'
import { INCIDENT_CATEGORIES } from '@/domain/incident'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { apiError, apiOk, newRequestId } from '@/lib/http'

export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  const requestId = newRequestId()

  const auth = await authenticate()
  if (!auth.ok) return apiError('UNAUTHENTICATED', 'Sign in to continue.', 401, { requestId })

  let payload: Record<string, unknown>
  try {
    payload = (await request.json()) as Record<string, unknown>
  } catch {
    return apiError('INVALID_BODY', 'Send a JSON body.', 400, { requestId })
  }

  const result = await openIncident({
    db: supabaseAdmin(),
    reporterUserId: auth.auth.userId,
    category: payload['category'],
    narrative: payload['narrative'],
    businessId: typeof payload['businessId'] === 'string' ? payload['businessId'] : undefined,
    subscriptionId:
      typeof payload['subscriptionId'] === 'string' ? payload['subscriptionId'] : undefined,
    occurrenceId:
      typeof payload['occurrenceId'] === 'string' ? payload['occurrenceId'] : undefined,
    now: new Date(),
    ip: clientIp(request),
  })

  if (!result.ok) {
    return apiError(result.code, result.message, result.code === 'INVALID' ? 422 : 500, {
      requestId,
      ...(result.code === 'INVALID'
        ? { fieldErrors: { category: `One of: ${INCIDENT_CATEGORIES.join(', ')}` } }
        : {}),
    })
  }

  // The reporter is told when somebody will have looked. SAFETY_TRUST_POLICY
  // section 16 also means this is never the place to imply we can dispatch
  // help -- an emergency goes to emergency services, not to a queue.
  return apiOk(
    {
      incidentId: result.incidentId,
      severity: result.severity,
      respondBy: result.respondBy,
      emergencyNotice:
        'If someone is in immediate danger, contact your local emergency services. Count On Local cannot dispatch help.',
    },
    201,
  )
}

export async function GET(request: Request): Promise<Response> {
  const requestId = newRequestId()

  const auth = await authenticate()
  if (!auth.ok) return apiError('UNAUTHENTICATED', 'Sign in to continue.', 401, { requestId })

  const result = await incidentQueue({
    db: supabaseAdmin(),
    actor: { userId: auth.auth.userId, roles: auth.auth.roles, ip: clientIp(request) },
    now: new Date(),
  })

  if (!result.ok) {
    return apiError(result.code, result.message, result.code === 'NOT_AUTHORIZED' ? 403 : 500, {
      requestId,
    })
  }

  return apiOk({ items: result.items })
}
