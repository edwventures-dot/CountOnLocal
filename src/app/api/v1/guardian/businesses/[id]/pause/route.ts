/**
 * POST   /v1/guardian/businesses/{id}/pause   stop it now
 * DELETE /v1/guardian/businesses/{id}/pause   put it back
 *
 * PRD section 15: a guardian can "pause the provider business
 * immediately". This is that button, and it is deliberately separate from
 * revoking consent.
 *
 * Revoking is a statement about the relationship and moves the guardian
 * state machine. Pausing is a statement about right now. A guardian who had
 * to revoke in order to stop things for an afternoon would either not stop
 * them when they should, or revoke when they did not mean to.
 *
 * The storefront comes down immediately. Scheduled work is not cancelled --
 * those visits are sold and somebody is expecting them, and what to do
 * about them is a decision SAFETY_TRUST_POLICY section 2 gives to the
 * guardian and support together, not to one button. The response says how
 * many are outstanding so the guardian can see what they have not decided.
 */

import { authenticate, clientIp } from '@/server/auth'
import { pauseBusinessAsGuardian, resumeBusinessAsGuardian } from '@/server/guardianDashboard'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { apiError, apiOk, newRequestId } from '@/lib/http'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

function statusFor(code: string): number {
  if (code === 'NOT_FOUND') return 404
  if (code === 'NOT_AUTHORIZED') return 403
  if (code === 'NOT_PAUSABLE') return 409
  return 500
}

export async function POST(request: Request, { params }: Params): Promise<Response> {
  const requestId = newRequestId()

  const auth = await authenticate()
  if (!auth.ok) return apiError('UNAUTHENTICATED', 'Sign in to continue.', 401, { requestId })

  const { id } = await params

  let reasonCode: string | null = null
  try {
    const text = await request.text()
    if (text) reasonCode = (JSON.parse(text) as { reasonCode?: string }).reasonCode ?? null
  } catch {
    // A pause must not fail because the body was malformed. Stopping is the
    // safe action; the reason is a nicety.
  }

  const result = await pauseBusinessAsGuardian({
    db: supabaseAdmin(),
    businessId: id,
    guardianUserId: auth.auth.userId,
    reasonCode,
    ip: clientIp(request),
  })

  if (!result.ok) {
    return apiError(result.code, result.message, statusFor(result.code), { requestId })
  }

  return apiOk({
    businessId: id,
    state: result.state,
    // Not cancelled, just outstanding. Named so a guardian can see there is
    // a second decision waiting rather than assuming this handled it.
    outstandingVisits: result.affectedOccurrences,
  })
}

export async function DELETE(request: Request, { params }: Params): Promise<Response> {
  const requestId = newRequestId()

  const auth = await authenticate()
  if (!auth.ok) return apiError('UNAUTHENTICATED', 'Sign in to continue.', 401, { requestId })

  const { id } = await params

  const result = await resumeBusinessAsGuardian({
    db: supabaseAdmin(),
    businessId: id,
    guardianUserId: auth.auth.userId,
    ip: clientIp(request),
  })

  if (!result.ok) {
    return apiError(result.code, result.message, statusFor(result.code), { requestId })
  }

  return apiOk({ businessId: id, state: result.state })
}
