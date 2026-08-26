/**
 * POST /v1/messages/{id}/report
 *
 * PRD section 17: either party can report a message.
 * SAFETY_TRUST_POLICY section 9: block and report are always available, and
 * safety reports outrank ordinary support.
 *
 * This is the case the automatic patterns cannot cover -- a human saying
 * something is wrong that no regular expression was going to catch. Which
 * is exactly why the button has to exist and has to be easy to reach.
 *
 * Reporting extends the retention clock. A reported message is evidence
 * whatever a reviewer eventually decides about it.
 */

import { authenticate, clientIp } from '@/server/auth'
import { reportMessage } from '@/server/messageService'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { apiError, apiOk, newRequestId } from '@/lib/http'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

export async function POST(request: Request, { params }: Params): Promise<Response> {
  const requestId = newRequestId()

  const auth = await authenticate()
  if (!auth.ok) return apiError('UNAUTHENTICATED', 'Sign in to continue.', 401, { requestId })

  const { id } = await params

  let payload: { reason?: unknown }
  try {
    payload = (await request.json()) as typeof payload
  } catch {
    return apiError('INVALID_BODY', 'Send a JSON body.', 400, { requestId })
  }

  const result = await reportMessage({
    db: supabaseAdmin(),
    messageId: id,
    reporterUserId: auth.auth.userId,
    reason: typeof payload.reason === 'string' ? payload.reason : '',
    now: new Date(),
    ip: clientIp(request),
  })

  if (!result.ok) {
    const status =
      result.code === 'NOT_FOUND'
        ? 404
        : result.code === 'NOT_A_PARTICIPANT'
          ? 403
          : result.code === 'INVALID'
            ? 422
            : 500
    return apiError(result.code, result.message, status, { requestId })
  }

  return apiOk({ messageId: id, reported: true })
}
