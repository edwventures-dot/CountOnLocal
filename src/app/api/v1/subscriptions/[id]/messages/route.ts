/**
 * GET  /v1/subscriptions/{id}/messages   the thread
 * POST /v1/subscriptions/{id}/messages   say something
 *
 * PRD section 17: messaging is service-linked. The subscription IS the
 * thread -- there is no way to open a conversation with somebody you are
 * not doing business with.
 *
 * Reads go through the caller's own client, so 0023 decides what comes
 * back: delivered messages only, and only to the two parties or a verified
 * guardian of a minor provider. A blocked message is stored and is
 * unreadable by anyone here, which is the whole reason it was blocked
 * rather than delivered and flagged.
 *
 * Sends go through the privileged client, because a message has to be
 * checked against the content rules before it lands and a refused one has
 * to be recorded without being readable.
 */

import { authenticate, clientIp } from '@/server/auth'
import { sendMessage } from '@/server/messageService'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { apiError, apiOk, newRequestId } from '@/lib/http'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

export async function GET(_request: Request, { params }: Params): Promise<Response> {
  const requestId = newRequestId()

  const auth = await authenticate()
  if (!auth.ok) return apiError('UNAUTHENTICATED', 'Sign in to continue.', 401, { requestId })

  const { id } = await params
  const db = await createSupabaseServerClient()

  const { data: thread } = await db
    .from('message_threads')
    .select('id, involves_minor, last_message_at')
    .eq('subscription_id', id)
    .maybeSingle()

  if (!thread) {
    // No thread yet is not an error -- nobody has said anything.
    return apiOk({ subscriptionId: id, messages: [], lastMessageAt: null })
  }

  const { data: messages } = await db
    .from('messages')
    .select('id, sender_user_id, body, created_at, read_at')
    .eq('thread_id', thread.id)
    .order('created_at', { ascending: true })

  return apiOk({
    subscriptionId: id,
    lastMessageAt: thread.last_message_at,
    messages: (messages ?? []).map((m) => ({
      id: m.id,
      senderUserId: m.sender_user_id,
      body: m.body,
      sentAt: m.created_at,
      readAt: m.read_at,
      mine: m.sender_user_id === auth.auth.userId,
    })),
  })
}

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

  if (typeof payload.body !== 'string') {
    return apiError('VALIDATION_FAILED', 'Write something first.', 422, {
      requestId,
      fieldErrors: { body: 'Required.' },
    })
  }

  const result = await sendMessage({
    db: supabaseAdmin(),
    subscriptionId: id,
    senderUserId: auth.auth.userId,
    body: payload.body,
    now: new Date(),
    ip: clientIp(request),
  })

  if (!result.ok) {
    const status =
      result.code === 'NOT_FOUND'
        ? 404
        : result.code === 'NOT_A_PARTICIPANT'
          ? 403
          : result.code === 'BLOCKED'
            ? 422
            : result.code === 'INVALID'
              ? 422
              : 500

    // The reason is returned so the sender knows what to change. The
    // pattern that matched is not, because that is a hint about how to
    // rephrase it and get through.
    return apiError(result.code, result.message, status, { requestId })
  }

  return apiOk({ messageId: result.messageId }, 201)
}
