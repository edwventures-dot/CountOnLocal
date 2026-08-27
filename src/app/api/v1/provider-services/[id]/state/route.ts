/**
 * PUT /v1/provider-services/{id}/state
 *
 * Turns a service on or off. The transition that was missing: services
 * were created as `draft`, publish requires an `active` one, and nothing
 * moved between the two.
 *
 * Activating is refused when the service has no schedule or no area, which
 * are the same conditions publish would complain about -- better to say so
 * when the provider asks than to let them find out at the last step.
 */

import { guard, parseJson, fieldErrorsFrom } from '@/app/api/v1/_shared'
import { setServiceState, serviceStateSchema } from '@/server/businessService'
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

  const parsed = serviceStateSchema.safeParse(parsedBody.body)
  if (!parsed.success) {
    return apiError('VALIDATION_FAILED', 'Check the highlighted fields.', 400, {
      requestId,
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    })
  }

  const { id } = await ctx.params
  const result = await setServiceState({
    db: supabaseAdmin(),
    providerUserId: auth.userId,
    providerServiceId: id,
    input: parsed.data,
    ip: clientIp(req),
  })

  if (!result.ok) {
    switch (result.code) {
      case 'SERVICE_NOT_FOUND':
        return apiError('NOT_FOUND', 'That service was not found.', 404, { requestId })
      case 'MISSING_AREA':
        return apiError(result.code, 'Set where you go before turning this on.', 409, { requestId })
      case 'MISSING_SCHEDULE':
        return apiError(result.code, 'Set a day before turning this on.', 409, { requestId })
      default:
        return apiError('INTERNAL_ERROR', 'Something went wrong. Please try again.', 500, {
          requestId,
        })
    }
  }

  return apiOk({ serviceId: id, state: result.state })
}
