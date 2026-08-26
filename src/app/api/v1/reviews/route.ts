/**
 * POST /v1/reviews
 *
 * API_CONTRACT: "Requires eligible completed paid relationship."
 *
 * That eligibility is three separate facts -- the visit was delivered, it
 * belongs to this customer, and this billing cycle has not already been
 * reviewed -- and all three are resolved from the database in
 * reviewService, not trusted from the request.
 *
 * The ownership check runs before the delivery check on purpose. A stranger
 * probing an occurrence id gets "not yours" rather than "not delivered
 * yet", and so learns nothing about whether the visit exists.
 */

import { authenticate, clientIp } from '@/server/auth'
import { createReview } from '@/server/reviewService'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { apiError, apiOk, newRequestId } from '@/lib/http'

export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  const requestId = newRequestId()

  const auth = await authenticate()
  if (!auth.ok) return apiError('UNAUTHENTICATED', 'Sign in to continue.', 401, { requestId })

  let body: { occurrenceId?: unknown; rating?: unknown; body?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return apiError('INVALID_BODY', 'Send a JSON body.', 400, { requestId })
  }

  if (typeof body.occurrenceId !== 'string') {
    return apiError('VALIDATION_FAILED', 'Which visit are you reviewing?', 422, {
      requestId,
      fieldErrors: { occurrenceId: 'Required.' },
    })
  }

  const result = await createReview({
    db: supabaseAdmin(),
    occurrenceId: body.occurrenceId,
    actorUserId: auth.auth.userId,
    rating: body.rating,
    body: body.body,
    ip: clientIp(request),
  })

  if (!result.ok) {
    const status =
      result.code === 'NOT_FOUND'
        ? 404
        : result.code === 'NOT_ELIGIBLE' || result.code === 'ALREADY_EXISTS'
          ? 409
          : result.code === 'INVALID'
            ? 422
            : 500
    return apiError(result.code, result.message, status, { requestId })
  }

  return apiOk({ reviewId: result.reviewId }, 201)
}
