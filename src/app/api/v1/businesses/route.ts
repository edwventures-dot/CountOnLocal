/** POST /v1/businesses -- create a draft business (API_CONTRACT). */

import { guard, parseJson, fieldErrorsFrom } from '@/app/api/v1/_shared'
import { createBusiness, createBusinessSchema } from '@/server/businessService'
import { apiError, apiOk } from '@/lib/http'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { clientIp } from '@/server/auth'

export async function POST(req: Request): Promise<Response> {
  const g = await guard('business:draft')
  if (!g.ok) return g.response
  const { auth, requestId } = g

  const parsedBody = await parseJson(req)
  if (!parsedBody.ok) {
    return apiError('INVALID_JSON', 'Request body must be JSON.', 400, { requestId })
  }

  const parsed = createBusinessSchema.safeParse(parsedBody.body)
  if (!parsed.success) {
    return apiError('VALIDATION_FAILED', 'Check the highlighted fields.', 400, {
      requestId,
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    })
  }

  const result = await createBusiness({
    db: supabaseAdmin(),
    providerUserId: auth.userId,
    input: parsed.data,
    now: new Date(),
    ip: clientIp(req),
  })

  if (!result.ok) {
    switch (result.code) {
      case 'NO_PROVIDER_PROFILE':
        return apiError(result.code, 'Complete provider onboarding first.', 409, { requestId })
      case 'PROVIDER_INELIGIBLE':
        return apiError(result.code, 'This account is not eligible to provide services.', 403, {
          requestId,
        })
      case 'SLUG_UNAVAILABLE':
        return apiError(result.code, 'That web address is not available.', 409, { requestId })
      case 'ALREADY_HAS_LIVE_BUSINESS':
        return apiError(result.code, 'You already have a live business.', 409, { requestId })
      default:
        return apiError('INTERNAL_ERROR', 'Something went wrong. Please try again.', 500, {
          requestId,
        })
    }
  }

  return apiOk({ businessId: result.businessId, slug: result.slug, state: 'draft' }, 201)
}
