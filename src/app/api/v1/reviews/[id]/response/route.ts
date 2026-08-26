/**
 * POST /v1/reviews/{id}/response
 *
 * The provider's single public reply. PRD section 19 allows one, and it is
 * not editable afterwards -- a reply that can be rewritten is one a
 * customer cannot rely on having read, and moderation would be looking at a
 * moving target.
 */

import { authenticate, clientIp } from '@/server/auth'
import { respondToReview } from '@/server/reviewService'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { apiError, apiOk, newRequestId } from '@/lib/http'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

export async function POST(request: Request, { params }: Params): Promise<Response> {
  const requestId = newRequestId()

  const auth = await authenticate()
  if (!auth.ok) return apiError('UNAUTHENTICATED', 'Sign in to continue.', 401, { requestId })

  const { id } = await params

  let payload: { body?: unknown }
  try {
    payload = (await request.json()) as typeof payload
  } catch {
    return apiError('INVALID_BODY', 'Send a JSON body.', 400, { requestId })
  }

  const result = await respondToReview({
    db: supabaseAdmin(),
    reviewId: id,
    actorUserId: auth.auth.userId,
    body: payload.body,
    ip: clientIp(request),
  })

  if (!result.ok) {
    const status =
      result.code === 'NOT_FOUND'
        ? 404
        : result.code === 'NOT_AUTHORIZED'
          ? 403
          : result.code === 'INVALID'
            ? 409
            : 500
    return apiError(result.code, result.message, status, { requestId })
  }

  return apiOk({ reviewId: id, responded: true })
}
