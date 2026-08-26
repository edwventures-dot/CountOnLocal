/**
 * POST /v1/reviews/{id}/report
 *
 * API_CONTRACT: "Moderation queue."
 *
 * Some reasons take the review out of public view immediately, before a
 * human has read anything. The asymmetry is deliberate: a wrongly hidden
 * review costs a provider a day of one review not showing, while a review
 * carrying a customer's phone number or a threat aimed at a minor stays
 * public until somebody works through the queue.
 *
 * Anyone signed in may report. Restricting it to the two parties would miss
 * the case that matters most -- a stranger reading a public storefront and
 * seeing something that should not be there.
 */

import { authenticate, clientIp } from '@/server/auth'
import { reportReview } from '@/server/reviewService'
import { REPORT_REASONS } from '@/domain/review'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { apiError, apiOk, newRequestId } from '@/lib/http'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

export async function POST(request: Request, { params }: Params): Promise<Response> {
  const requestId = newRequestId()

  const auth = await authenticate()
  if (!auth.ok) return apiError('UNAUTHENTICATED', 'Sign in to continue.', 401, { requestId })

  const { id } = await params

  let payload: { reason?: unknown; detail?: unknown }
  try {
    payload = (await request.json()) as typeof payload
  } catch {
    return apiError('INVALID_BODY', 'Send a JSON body.', 400, { requestId })
  }

  const result = await reportReview({
    db: supabaseAdmin(),
    reviewId: id,
    reporterUserId: auth.auth.userId,
    reason: payload.reason,
    detail: typeof payload.detail === 'string' ? payload.detail : undefined,
    ip: clientIp(request),
  })

  if (!result.ok) {
    const status =
      result.code === 'NOT_FOUND'
        ? 404
        : result.code === 'ALREADY_REPORTED'
          ? 409
          : result.code === 'INVALID'
            ? 422
            : 500
    return apiError(result.code, result.message, status, {
      requestId,
      ...(result.code === 'INVALID' ? { fieldErrors: { reason: `One of: ${REPORT_REASONS.join(', ')}` } } : {}),
    })
  }

  return apiOk({
    reviewId: id,
    reported: true,
    // Told plainly rather than left to guess. A reporter who sees the
    // review still up should know whether that is expected.
    hiddenPendingReview: result.hidden,
  })
}
