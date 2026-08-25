/**
 * PUT /v1/provider-services/{id}/service-area
 *
 * The private geometry stored here is what address eligibility is computed
 * against and is never returned to an unauthenticated caller. The response
 * deliberately echoes nothing back but an id.
 */

import { guard, parseJson, fieldErrorsFrom } from '@/app/api/v1/_shared'
import { setServiceArea, serviceAreaSchema } from '@/server/businessService'
import { apiError, apiOk } from '@/lib/http'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { clientIp } from '@/server/auth'

export async function PUT(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const g = await guard('service:configure')
  if (!g.ok) return g.response
  const { auth, requestId } = g

  const parsedBody = await parseJson(req)
  if (!parsedBody.ok) {
    return apiError('INVALID_JSON', 'Request body must be JSON.', 400, { requestId })
  }

  const parsed = serviceAreaSchema.safeParse(parsedBody.body)
  if (!parsed.success) {
    return apiError('VALIDATION_FAILED', 'Check the highlighted fields.', 400, {
      requestId,
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    })
  }

  const { id } = await ctx.params
  const result = await setServiceArea({
    db: supabaseAdmin(),
    providerUserId: auth.userId,
    providerServiceId: id,
    input: parsed.data,
    now: new Date(),
    ip: clientIp(req),
  })

  if (!result.ok) {
    if (result.code === 'SERVICE_NOT_FOUND') {
      return apiError('NOT_FOUND', 'That service was not found.', 404, { requestId })
    }
    return apiError('INTERNAL_ERROR', 'Something went wrong. Please try again.', 500, { requestId })
  }

  return apiOk({ serviceAreaId: result.serviceAreaId })
}
