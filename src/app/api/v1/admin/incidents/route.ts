/**
 * GET /v1/admin/incidents
 *
 * The work queue, most urgent first. Ordering lives in adminService so the
 * console cannot quietly re-sort it -- an overdue S1 outranking a fresh one
 * is a safety property, not a display preference.
 *
 * Returns ids and severities, never the people involved. Whether a staff
 * member may see a customer address is a separate, audited decision --
 * see readCustomerAddress. A queue that carried addresses would make that
 * audit meaningless.
 */

import { authenticate } from '@/server/auth'
import { incidentQueue } from '@/server/adminService'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { apiError, apiOk, newRequestId } from '@/lib/http'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  const requestId = newRequestId()

  const auth = await authenticate()
  if (!auth.ok) return apiError('UNAUTHENTICATED', 'Sign in to continue.', 401, { requestId })

  const result = await incidentQueue({
    db: supabaseAdmin(),
    actor: { userId: auth.auth.userId, roles: auth.auth.roles },
    now: new Date(),
  })

  if (!result.ok) {
    // 404 rather than 403 for a caller with no business here. A 403
    // confirms the console exists and that they were close.
    if (result.code === 'NOT_AUTHORIZED') return new Response(null, { status: 404 })
    return apiError(result.code, result.message, 500, { requestId })
  }

  return apiOk({ items: result.items })
}
