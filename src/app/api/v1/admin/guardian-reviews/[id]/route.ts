/**
 * POST /v1/admin/guardian-reviews/{id}
 *
 * Approving or denying a young provider after meeting the family.
 *
 * The decision is made over a kitchen table; this records it. So the body
 * carries what a note would carry -- what you concluded, whether you were
 * actually in the room, and who was there -- rather than a bare verdict.
 *
 * `metInPerson` is required rather than defaulted true. A default would
 * make the strongest claim in the record the one nobody had to make, and
 * the day somebody approves one over the phone is exactly the day it needs
 * to be legible that they did.
 *
 * Authorization is `guardian:review`, checked in the service against roles
 * from the session. The guardian's own consent does not grant it: they have
 * already given their answer, and this is the separate question of whether
 * somebody else thinks the arrangement is sound.
 */

import { authenticate } from '@/server/auth'
import { reviewGuardianRelationship } from '@/server/guardianReview'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { apiError, apiOk, newRequestId } from '@/lib/http'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

export async function POST(request: Request, { params }: Params): Promise<Response> {
  const requestId = newRequestId()

  const auth = await authenticate()
  if (!auth.ok) return apiError('UNAUTHENTICATED', 'Sign in to continue.', 401, { requestId })

  const { id } = await params

  let payload: {
    approve?: unknown
    reason?: unknown
    metInPerson?: unknown
    present?: unknown
  }
  try {
    payload = (await request.json()) as typeof payload
  } catch {
    return apiError('INVALID_BODY', 'Send a JSON body.', 400, { requestId })
  }

  if (typeof payload.approve !== 'boolean') {
    return apiError('INVALID_BODY', 'approve must be true or false.', 400, { requestId })
  }
  if (typeof payload.metInPerson !== 'boolean') {
    return apiError(
      'INVALID_BODY',
      'metInPerson must be true or false. Say which it was.',
      400,
      { requestId },
    )
  }
  if (typeof payload.reason !== 'string') {
    return apiError('INVALID_BODY', 'reason is required.', 400, { requestId })
  }

  const result = await reviewGuardianRelationship({
    db: supabaseAdmin(),
    relationshipId: id,
    reviewerUserId: auth.auth.userId,
    reviewerRoles: auth.auth.roles,
    approve: payload.approve,
    reason: payload.reason,
    metInPerson: payload.metInPerson,
    present: typeof payload.present === 'string' ? payload.present : null,
  })

  if (!result.ok) {
    const status =
      result.code === 'NOT_AUTHORIZED'
        ? 403
        : result.code === 'NOT_FOUND'
          ? 404
          : result.code === 'REASON_REQUIRED' || result.code === 'ILLEGAL_TRANSITION'
            ? 422
            : 500
    return apiError(result.code, result.message, status, { requestId })
  }

  return apiOk({ relationshipId: id, state: result.state, reviewId: result.reviewId })
}
