/**
 * POST /v1/checkout/preview
 *
 * API_CONTRACT: "Calculates provider subtotal, platform fee, billing cycle,
 * tax if any, start date, and eligibility."
 *
 * Unauthenticated on purpose. PRD section 10 puts price and fee review
 * before account creation, and someone standing on a porch with a flyer
 * should see the real total -- fee included -- before being asked to sign up
 * for anything.
 */

import { createClient } from '@supabase/supabase-js'
import { previewCheckout, previewSchema } from '@/server/checkoutService'
import { publicEnv } from '@/lib/env'
import { apiError, apiOk, newRequestId } from '@/lib/http'
import { fieldErrorsFrom, parseJson } from '@/app/api/v1/_shared'
import type { Database } from '@/lib/supabase/types'

export async function POST(req: Request): Promise<Response> {
  const requestId = newRequestId()

  const parsedBody = await parseJson(req)
  if (!parsedBody.ok) {
    return apiError('INVALID_JSON', 'Request body must be JSON.', 400, { requestId })
  }

  const parsed = previewSchema.safeParse(parsedBody.body)
  if (!parsed.success) {
    return apiError('VALIDATION_FAILED', 'Check the highlighted fields.', 400, {
      requestId,
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    })
  }

  const env = publicEnv()
  const db = createClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  )

  const result = await previewCheckout({ db, input: parsed.data, now: new Date() })

  if (!result.ok) {
    switch (result.code) {
      case 'SERVICE_NOT_FOUND':
      case 'NO_SCHEDULE':
        return apiError('NOT_FOUND', 'That service was not found.', 404, { requestId })
      case 'ADDRESS_NOT_FOUND':
        return apiError(result.code, 'We could not find that address. Check the spelling and ZIP.', 422, { requestId })
      case 'ADDRESS_AMBIGUOUS':
        return apiError(result.code, 'That address matched more than one place. Add an apartment or unit number.', 422, { requestId })
      case 'UNSUPPORTED_COUNTRY':
        return apiError(result.code, 'Count On Local is US-only right now.', 422, { requestId })
      default:
        return apiError('GEOCODER_UNAVAILABLE', 'We could not check that address right now. Please try again.', 503, { requestId })
    }
  }

  const p = result.preview
  return apiOk({
    business: { name: p.businessName, slug: p.businessSlug },
    serviceName: p.serviceName,
    eligible: p.eligible,
    atCapacity: p.atCapacity,
    normalizedAddress: p.normalizedAddress,
    price: { cents: p.priceCents, unit: p.priceUnit },
    billing: {
      cycleWeeks: p.billingCycleWeeks,
      occurrences: p.quote.occurrences,
      serviceSubtotalCents: p.quote.serviceSubtotalCents,
      platformFeeCents: p.quote.platformFeeCents,
      totalCents: p.quote.customerTotalCents,
      // Reported so the customer sees what they are actually paying when the
      // minimum fee bites on a cheap service, not just the headline rate.
      effectiveFeeBasisPoints: p.quote.effectiveFeeBasisPoints,
      minimumFeeApplied: p.quote.minimumApplied,
    },
    earliestStartDate: p.earliestStartDate,
    firstCycleDates: p.firstCycleDates,
  })
}
