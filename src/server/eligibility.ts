/**
 * Address eligibility (API_CONTRACT, customer flow).
 *
 * PRD section 10 step 3: "Backend geocodes address and verifies it is within
 * provider service area."
 *
 * The asymmetry here is the whole design. A customer learns yes or no about
 * their own address and nothing else -- never the polygon, never how close
 * they were, never which other houses are inside. For a minor provider the
 * shape of the area they serve is a location hint, so the answer is a single
 * boolean and the geometry never leaves the database
 * (SAFETY_TRUST_POLICY section 3).
 */

import { z } from 'zod'
import { getGeocoder, type AddressInput } from '@/server/geocoder'
import { checkRegionAllowed } from '@/server/jurisdictionService'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'

type Db = SupabaseClient<Database>

export const addressSchema = z.object({
  line1: z.string().trim().min(3).max(120),
  line2: z.string().trim().max(80).optional(),
  city: z.string().trim().min(1).max(80),
  region: z.string().trim().length(2).toUpperCase(),
  postalCode: z.string().trim().regex(/^[0-9]{5}(-[0-9]{4})?$/, 'Use a 5 or 9 digit ZIP'),
  countryCode: z.string().trim().length(2).toUpperCase().default('US'),
})
export type AddressFields = z.infer<typeof addressSchema>

export type EligibilityResult =
  | {
      ok: true
      eligible: boolean
      /** The geocoder's normalized form, so the customer can confirm we
       *  understood the address they meant. */
      normalizedAddress: string
      /**
       * Where the geocoder put the house.
       *
       * Present ONLY when the caller passes includePoint. The default
       * answer is yes-or-no plus the normalised address and nothing else,
       * and there is a test asserting exactly those three keys -- this
       * endpoint is reachable unauthenticated, so every extra field in the
       * default shape is a decision, not an accident.
       *
       * Checkout asks for it so it can persist the point (0018) rather than
       * geocoding the same house twice.
       */
      point?: { latitude: number; longitude: number } | undefined
    }
  | {
      ok: false
      code:
        | 'SERVICE_NOT_FOUND'
        | 'ADDRESS_NOT_FOUND'
        | 'ADDRESS_AMBIGUOUS'
        | 'GEOCODER_UNAVAILABLE'
        | 'UNSUPPORTED_COUNTRY'
        | 'STATE_BLOCKED'
        | 'SERVICE_BLOCKED_IN_STATE'
        | 'STATE_NOT_CLEARED'
      /**
       * Present for the jurisdiction refusals. The other codes map to a
       * fixed sentence at the route; these carry the state name and have
       * to say which one.
       */
      message?: string | undefined
    }

/**
 * Checks one address against one published service.
 *
 * Runs unauthenticated: a neighbour who scans a flyer must be able to ask
 * "do you cover my house" before creating an account. The only thing they
 * can learn is a yes or no about an address they typed themselves.
 */
export async function checkAddressEligibility(args: {
  db: Db
  providerServiceId: string
  address: AddressFields
  signal?: AbortSignal
  /**
   * Return the geocoded point alongside the answer. Off by default: see
   * EligibilityResult.point.
   */
  includePoint?: boolean | undefined
}): Promise<EligibilityResult> {
  const { db, providerServiceId, address } = args

  if (address.countryCode !== 'US') return { ok: false, code: 'UNSUPPORTED_COUNTRY' }

  // Confirm the service is actually offered before spending a geocoder call,
  // and so an unpublished service is indistinguishable from a missing one.
  const { data: service } = await db
    .from('provider_services')
    .select('id, state, service_catalog!inner(code), businesses!inner(state)')
    .eq('id', providerServiceId)
    .eq('state', 'active')
    .eq('businesses.state', 'published')
    .maybeSingle()

  if (!service) return { ok: false, code: 'SERVICE_NOT_FOUND' }

  // Before the geocoder, deliberately. A refusal costs nothing, whereas a
  // geocoder call for an address we cannot serve costs money and hands a
  // third party somebody's house for no reason.
  //
  // Product owner's response of 2026-08-30 item 9: the platform is
  // multi-state, and counsel flags the states that must wait.
  const jurisdiction = await checkRegionAllowed({
    db,
    region: address.region,
    // The catalog CODE, not the row id: a jurisdiction rule written by
    // counsel names 'dog_walking', not a uuid nobody can read.
    catalogCode: (service as { service_catalog?: { code?: string } }).service_catalog?.code,
  })

  if (!jurisdiction.allowed) {
    return { ok: false, code: jurisdiction.code, message: jurisdiction.message }
  }

  const input: AddressInput = {
    line1: address.line1,
    line2: address.line2,
    city: address.city,
    region: address.region,
    postalCode: address.postalCode,
  }

  const geocoded = await getGeocoder().geocode(input, args.signal)
  if (!geocoded.ok) {
    switch (geocoded.code) {
      case 'NO_MATCH':
        return { ok: false, code: 'ADDRESS_NOT_FOUND' }
      case 'AMBIGUOUS':
        return { ok: false, code: 'ADDRESS_AMBIGUOUS' }
      case 'UNSUPPORTED_COUNTRY':
        return { ok: false, code: 'UNSUPPORTED_COUNTRY' }
      default:
        return { ok: false, code: 'GEOCODER_UNAVAILABLE' }
    }
  }

  // Point-in-polygon happens in the database. The polygon is never selected,
  // never serialized, and never crosses a process boundary.
  const { data, error } = await db.rpc('address_point_is_eligible' as never, {
    p_provider_service_id: providerServiceId,
    p_lat: geocoded.latitude,
    p_lng: geocoded.longitude,
  } as never)

  if (error) {
    console.error('[eligibility] point-in-polygon failed', error.message)
    return { ok: false, code: 'GEOCODER_UNAVAILABLE' }
  }

  return {
    ok: true,
    eligible: data === true,
    normalizedAddress: geocoded.normalizedAddress,
    ...(args.includePoint
      ? { point: { latitude: geocoded.latitude, longitude: geocoded.longitude } }
      : {}),
  }
}
