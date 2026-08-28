/** POST /v1/businesses/{id}/services -- add a service from the catalog. */

import { guard, parseJson, fieldErrorsFrom } from '@/app/api/v1/_shared'
import { addService, addServiceSchema } from '@/server/businessService'
import { apiError, apiOk } from '@/lib/http'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { clientIp } from '@/server/auth'

export async function POST(
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

  const parsed = addServiceSchema.safeParse(parsedBody.body)
  if (!parsed.success) {
    return apiError('VALIDATION_FAILED', 'Check the highlighted fields.', 400, {
      requestId,
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    })
  }

  const { id } = await ctx.params
  const result = await addService({
    db: supabaseAdmin(),
    providerUserId: auth.userId,
    businessId: id,
    input: parsed.data,
    now: new Date(),
    ip: clientIp(req),
  })

  if (!result.ok) {
      if (result.code === 'PRICE_TOO_HIGH') {
        return apiError(result.code, result.message ?? 'That price is too high.', 422, { requestId })
      }
    switch (result.code) {
      case 'BUSINESS_NOT_FOUND':
        return apiError('NOT_FOUND', 'That business was not found.', 404, { requestId })
      case 'UNKNOWN_CATALOG_SERVICE':
      case 'SERVICE_NOT_AVAILABLE':
        return apiError(result.code, 'That service is not available.', 400, { requestId })
      case 'PROVIDER_TOO_YOUNG':
      case 'ADULT_ONLY_CATEGORY':
        return apiError(result.code, 'This service is not available on this account.', 403, {
          requestId,
        })
      case 'GUARDIAN_APPROVAL_REQUIRED':
        return apiError(result.code, 'Guardian approval is required to continue.', 403, {
          requestId,
        })
      case 'CATEGORY_NOT_APPROVED_BY_GUARDIAN':
        return apiError(
          result.code,
          'Your guardian needs to approve this kind of service first.',
          403,
          { requestId },
        )
      case 'PROHIBITED_WORDING':
        // Names the rule that was touched without quoting the matched text
        // back, which would read as instructions for rewording around it.
        return apiError(
          result.code,
          'This description mentions work outside what this service covers.',
          422,
          {
            requestId,
            fieldErrors: Object.fromEntries(
              (result.flags ?? []).map((f) => ['description', f.reason]),
            ),
          },
        )
      default:
        return apiError('INTERNAL_ERROR', 'Something went wrong. Please try again.', 500, {
          requestId,
        })
    }
  }

  return apiOk({ serviceId: result.serviceId, slug: result.slug, state: 'draft' }, 201)
}
