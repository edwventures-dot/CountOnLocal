/**
 * POST /v1/subscriptions/{id}/cancel   end it, now
 * GET  /v1/subscriptions/{id}/cancel   what that would cost
 *
 * API_CONTRACT: "Self-service cancellation with effective date and
 * financial summary."
 *
 * PRD section 16 is unambiguous -- "No 'contact support to cancel' dark
 * pattern" -- so this is one authenticated call by the customer, it takes
 * effect the moment it succeeds, and there is no confirmation step the
 * server insists on. The GET exists so a client CAN show the money first;
 * it is not a gate the POST checks for.
 *
 * The financial summary is the honest part. Cancelling releases the rest of
 * the cycle the customer already paid for, under the same notice rules a
 * single skip uses, and refunds whatever credit has nowhere left to go.
 */

import { authenticate, clientIp } from '@/server/auth'
import { cancelSubscription, previewEnding } from '@/server/subscriptionService'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { isoDate } from '@/domain/schedule'
import { apiError, apiOk, newRequestId } from '@/lib/http'
import { track } from '@/server/analytics'
import type { EndingPlan } from '@/domain/subscription'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

function summarize(plan: EndingPlan) {
  return {
    effectiveFrom: isoDate(plan.effectiveFrom),
    visitsReleased: plan.released.length,
    visitsCredited: plan.released.filter((r) => r.credit.credited).length,
    visitsNotCredited: plan.released
      .filter((r) => !r.credit.credited)
      .map((r) => ({ occurrenceId: r.occurrenceId, reason: r.credit.message })),
    newCreditCents: plan.newCreditCents,
    refundableCents: plan.refundableCents,
  }
}

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
    ending: 'cancel',
  })

  if (!result.ok) {
    return apiError(result.code, result.message, result.code === 'NOT_FOUND' ? 404 : 403, {
      requestId,
    })
  }

  return apiOk({ subscriptionId: id, ...summarize(result.plan) })
}

export async function POST(request: Request, { params }: Params): Promise<Response> {
  const requestId = newRequestId()

  const auth = await authenticate()
  if (!auth.ok) return apiError('UNAUTHENTICATED', 'Sign in to continue.', 401, { requestId })

  const { id } = await params
  const result = await cancelSubscription({
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

  track({
    event: 'subscription_canceled',
    userId: auth.auth.userId,
    properties: {
      subscription_id: id,
      subscription_state: result.state,
      amount_cents: result.refundedCents,
    },
  })

  return apiOk({
    subscriptionId: id,
    state: result.state,
    ...summarize(result.plan),
    refundedCents: result.refundedCents,
    // Surfaced rather than hidden: the customer is owed this and support can
    // see it on the ledger. Saying nothing would be the dishonest choice.
    refundPending: result.refundPending,
  })
}
