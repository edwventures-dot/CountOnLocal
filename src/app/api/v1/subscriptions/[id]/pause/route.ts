/**
 * POST /v1/subscriptions/{id}/pause    stop for now
 * GET  /v1/subscriptions/{id}/pause    what that would cost
 * DELETE /v1/subscriptions/{id}/pause  resume
 *
 * API_CONTRACT, Subscriptions: "Pause range."
 *
 * Pausing does two separate things, and it is worth keeping them apart in
 * your head. The subscription state stops the NEXT cycle being charged. The
 * visits in the cycle already paid for are released one at a time under the
 * ordinary notice rules -- pausing is not a way to get a credit that
 * skipping would have refused.
 *
 * Nothing is refunded. A paused subscription can resume and spend its
 * credit on the next cycle; handing the money back and then charging again
 * would be worse for everyone. Cancelling is where a refund happens.
 *
 * Resume is DELETE on the same path rather than a separate verb: it removes
 * the pause. Nothing financial happens -- the credit is already on the
 * ledger and settlement finds it, and the horizon job regenerates the
 * released visits.
 */

import { authenticate, clientIp } from '@/server/auth'
import { pauseSubscription, previewEnding, resumeSubscription } from '@/server/subscriptionService'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { isoDate } from '@/domain/schedule'
import { apiError, apiOk, newRequestId } from '@/lib/http'
import { track } from '@/server/analytics'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

export async function GET(request: Request, { params }: Params): Promise<Response> {
  const requestId = newRequestId()

  const auth = await authenticate()
  if (!auth.ok) return apiError('UNAUTHENTICATED', 'Sign in to continue.', 401, { requestId })

  const { id } = await params
  const result = await previewEnding({
    db: supabaseAdmin(),
    subscriptionId: id,
    actorUserId: auth.auth.userId,
    now: new Date(),
    ending: 'pause',
  })

  if (!result.ok) {
    return apiError(result.code, result.message, result.code === 'NOT_FOUND' ? 404 : 403, {
      requestId,
    })
  }

  const plan = result.plan
  return apiOk({
    subscriptionId: id,
    effectiveFrom: isoDate(plan.effectiveFrom),
    visitsReleased: plan.released.length,
    visitsCredited: plan.released.filter((r) => r.credit.credited).length,
    newCreditCents: plan.newCreditCents,
    // Always zero for a pause. Stated explicitly so a client does not have
    // to infer it from the absence of a field.
    refundableCents: plan.refundableCents,
  })
}

export async function POST(request: Request, { params }: Params): Promise<Response> {
  const requestId = newRequestId()

  const auth = await authenticate()
  if (!auth.ok) return apiError('UNAUTHENTICATED', 'Sign in to continue.', 401, { requestId })

  const { id } = await params
  const result = await pauseSubscription({
    db: supabaseAdmin(),
    subscriptionId: id,
    actorUserId: auth.auth.userId,
    now: new Date(),
    ip: clientIp(request),
  })

  if (!result.ok) {
    const status =
      result.code === 'NOT_FOUND' ? 404 : result.code === 'NOT_YOUR_SUBSCRIPTION' ? 403 : 409
    return apiError(result.code, result.message, status, { requestId })
  }

  return apiOk({
    subscriptionId: id,
    state: result.state,
    effectiveFrom: isoDate(result.plan.effectiveFrom),
    visitsReleased: result.plan.released.length,
    visitsCredited: result.plan.released.filter((r) => r.credit.credited).length,
    newCreditCents: result.plan.newCreditCents,
  })
}

export async function DELETE(request: Request, { params }: Params): Promise<Response> {
  const requestId = newRequestId()

  const auth = await authenticate()
  if (!auth.ok) return apiError('UNAUTHENTICATED', 'Sign in to continue.', 401, { requestId })

  const { id } = await params
  const result = await resumeSubscription({
    db: supabaseAdmin(),
    subscriptionId: id,
    actorUserId: auth.auth.userId,
    ip: clientIp(request),
  })

  if (!result.ok) {
    const status =
      result.code === 'NOT_FOUND' ? 404 : result.code === 'NOT_YOUR_SUBSCRIPTION' ? 403 : 409
    return apiError(result.code, result.message, status, { requestId })
  }

  track({
    event: 'subscription_paused',
    userId: auth.auth.userId,
    properties: { subscription_id: id, subscription_state: result.state },
  })

  return apiOk({ subscriptionId: id, state: result.state })
}
