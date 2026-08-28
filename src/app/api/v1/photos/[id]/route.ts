/**
 * GET /v1/photos/{id}
 *
 * Serves a completion photo to somebody entitled to see it. Every fetch is
 * authorized -- there are no signed URLs, because a signed URL is checked
 * once and then works for anybody it is forwarded to, and these are
 * photographs taken outside a customer's house by a child.
 *
 * A caller who is not entitled gets 404. The existence of a photo for a
 * particular visit is itself information.
 */

import { authenticate } from '@/server/auth'
import { fetchCompletionPhoto } from '@/server/photoService'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { newRequestId } from '@/lib/http'

export const dynamic = 'force-dynamic'

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = newRequestId()

  const auth = await authenticate()
  // 404 rather than 401: a signed-out caller learns nothing about whether
  // this photo exists.
  if (!auth.ok) return new Response(null, { status: 404 })

  const { id } = await ctx.params
  const result = await fetchCompletionPhoto({
    db: supabaseAdmin(),
    photoId: id,
    viewerUserId: auth.auth.userId,
    viewerRoles: auth.auth.roles,
  })

  if (!result.ok) return new Response(null, { status: 404 })

  return new Response(result.bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      'Content-Type': result.contentType,
      // Never cached by anything in between. Authorization happens per
      // request and a shared cache would defeat it.
      'Cache-Control': 'no-store, private',
      'X-Request-Id': requestId,
      // The bytes are an image and must never be interpreted as anything
      // else, whatever a browser decides to sniff.
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline',
    },
  })
}
