/**
 * POST /v1/admin/refunds
 *
 * Fast in-app refund. The point of "fast" is economic rather than
 * hospitable: a customer who cannot get $3 back from us gets it back from
 * their bank, which costs a chargeback fee and damages the platform's
 * standing with Stripe. A slow refund process is more expensive than a
 * generous one.
 *
 * No reason is demanded below the threshold in domain/incident.ts.
 * Requiring an essay for a $3 credit trains staff to type filler, which
 * makes the log look complete while saying nothing.
 */

import { authenticate, clientIp } from '@/server/auth'
import { issueRefund } from '@/server/disputeService'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { apiError, apiOk, newRequestId } from '@/lib/http'

export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  const requestId = newRequestId()

  const auth = await authenticate()
  if (!auth.ok) return apiError('UNAUTHENTICATED', 'Sign in to continue.', 401, { requestId })

  let body: { subscriptionId?: string; amountCents?: number; reason?: unknown; incidentId?: string }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return apiError('INVALID_JSON', 'Request body must be JSON.', 400, { requestId })
  }

  if (!body.subscriptionId || typeof body.amountCents !== 'number') {
    return apiError('VALIDATION_FAILED', 'Which subscription, and how much?', 400, { requestId })
  }

  const result = await issueRefund({
    db: supabaseAdmin(),
    actor: { userId: auth.auth.userId, roles: auth.auth.roles, ip: clientIp(request) },
    subscriptionId: body.subscriptionId,
    amountCents: body.amountCents,
    reason: body.reason,
    ...(body.incidentId ? { incidentId: body.incidentId } : {}),
  })

  if (!result.ok) {
    // 404 for an unauthorised caller, as everywhere else in the console.
    if (result.code === 'NOT_AUTHORIZED') return new Response(null, { status: 404 })
    const status =
      result.code === 'NOT_FOUND'
        ? 404
        : result.code === 'PROCESSOR_FAILED'
          ? 503
          : result.code === 'WRITE_FAILED'
            ? 500
            : 422
    return apiError(result.code, result.message, status, { requestId })
  }

  return apiOk({ refundedCents: result.refundedCents, externalId: result.externalId })
}
