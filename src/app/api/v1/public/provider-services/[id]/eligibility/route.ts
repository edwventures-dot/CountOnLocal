/**
 * POST /v1/public/provider-services/{id}/eligibility
 *
 * API_CONTRACT: "Input customer address. Server geocodes/checks coverage and
 * capacity."
 *
 * Deliberately unauthenticated. A neighbour who scans a flyer must be able
 * to ask "do you cover my house" before creating an account -- requiring a
 * signup first would lose exactly the doorstep conversion the whole flyer
 * strategy depends on.
 *
 * The response is a boolean about an address the caller typed themselves.
 * It never reveals the service-area shape, how close they were, or which
 * other addresses are covered.
 */

import { createClient } from '@supabase/supabase-js'
import { checkAddressEligibility, addressSchema } from '@/server/eligibility'
import { publicEnv } from '@/lib/env'
import { apiError, apiOk, newRequestId } from '@/lib/http'
import { fieldErrorsFrom, parseJson } from '@/app/api/v1/_shared'
import { track } from '@/server/analytics'
import { postalPrefix } from '@/domain/analytics'
import type { Database } from '@/lib/supabase/types'

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = newRequestId()

  const parsedBody = await parseJson(req)
  if (!parsedBody.ok) {
    return apiError('INVALID_JSON', 'Request body must be JSON.', 400, { requestId })
  }

  const parsed = addressSchema.safeParse(parsedBody.body)
  if (!parsed.success) {
    return apiError('VALIDATION_FAILED', 'Check the highlighted fields.', 400, {
      requestId,
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    })
  }

  const env = publicEnv()
  // Anon client: the service and business visibility rules are row level
  // policies, so an unpublished service is invisible here for the same
  // reason it is invisible on the storefront.
  const db = createClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  )

  const { id } = await ctx.params
  const result = await checkAddressEligibility({
    db,
    providerServiceId: id,
    address: parsed.data,
  })

  // PRD section 25's `address_checked`. This is the one funnel event whose
  // call site has a full street address in scope, so the coarsening happens
  // here, explicitly, rather than being left to the allowlist to catch.
  // There is no user id: this endpoint is deliberately unauthenticated.
  track({
    event: 'address_checked',
    properties: {
      service_id: id,
      result: result.ok ? 'ok' : result.code,
      postal_prefix: postalPrefix(parsed.data.postalCode),
    },
  })

  if (!result.ok) {
    switch (result.code) {
      case 'SERVICE_NOT_FOUND':
        return apiError('NOT_FOUND', 'That service was not found.', 404, { requestId })
      case 'ADDRESS_NOT_FOUND':
        return apiError(result.code, 'We could not find that address. Check the spelling and ZIP.', 422, {
          requestId,
        })
      case 'ADDRESS_AMBIGUOUS':
        return apiError(result.code, 'That address matched more than one place. Add an apartment or unit number.', 422, {
          requestId,
        })
      case 'UNSUPPORTED_COUNTRY':
        return apiError(result.code, 'Count On Local is US-only right now.', 422, { requestId })
      default:
        return apiError('GEOCODER_UNAVAILABLE', 'We could not check that address right now. Please try again.', 503, {
          requestId,
        })
    }
  }

  if (result.eligible) {
    track({
      event: 'address_eligible',
      properties: { service_id: id, postal_prefix: postalPrefix(parsed.data.postalCode) },
    })
  }

  return apiOk({
    eligible: result.eligible,
    normalizedAddress: result.normalizedAddress,
    // The copy differs, but the shape does not: an ineligible answer reveals
    // nothing beyond "not this one".
    message: result.eligible
      ? 'Good news - this address is on the route.'
      : 'This address is outside the current service area.',
  })
}
