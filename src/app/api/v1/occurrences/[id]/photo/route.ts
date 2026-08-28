/**
 * POST /v1/occurrences/{id}/photo
 *
 * A completion photo. Raw image bytes as the body -- no multipart, because
 * there is exactly one file and parsing a multipart envelope to find it
 * would be work with a parser attached.
 *
 * The declared content type is not trusted. The bytes decide what this is,
 * and EXIF is removed before anything is stored.
 */

import { authenticate } from '@/server/auth'
import { uploadCompletionPhoto } from '@/server/photoService'
import { MAX_PHOTO_BYTES } from '@/domain/photo'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { apiError, apiOk, newRequestId } from '@/lib/http'

export const dynamic = 'force-dynamic'

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = newRequestId()

  const auth = await authenticate()
  if (!auth.ok) return apiError('UNAUTHENTICATED', 'Sign in to continue.', 401, { requestId })

  // Cheap refusal before reading the body, when the client is honest about
  // the size. The real limit is enforced on the bytes themselves.
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (declared > MAX_PHOTO_BYTES) {
    return apiError('TOO_LARGE', 'That photo is too big.', 413, { requestId })
  }

  const bytes = new Uint8Array(await request.arrayBuffer())

  const { id } = await ctx.params
  const result = await uploadCompletionPhoto({
    db: supabaseAdmin(),
    occurrenceId: id,
    providerUserId: auth.auth.userId,
    bytes,
  })

  if (!result.ok) {
    const status =
      result.code === 'NOT_FOUND'
        ? 404
        : result.code === 'NOT_YOURS'
          ? 403
          : result.code === 'ALREADY_EXISTS'
            ? 409
            : result.code === 'REJECTED'
              ? 422
              : 500
    return apiError(result.code, result.message, status, { requestId })
  }

  return apiOk({ photoId: result.photoId, strippedSegments: result.strippedSegments }, 201)
}
