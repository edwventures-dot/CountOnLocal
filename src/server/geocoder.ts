/**
 * Address geocoding.
 *
 * TECHNICAL_SPEC section 1 recommends Mapbox or Google Maps Platform, and
 * says vendors may change without changing the domain design. So this is an
 * interface with a US Census implementation behind it.
 *
 * The Census Geocoder is free, needs no API key, and covers exactly the
 * launch audience (US household addresses). That removes a vendor
 * dependency from V1 entirely. It is slower and less forgiving of messy
 * input than a commercial geocoder, which is the trade -- swapping in
 * Mapbox later means writing one more implementation of this interface.
 *
 * Addresses are never logged here. An address in an application log is an
 * address outside the access controls that protect it
 * (SAFETY_TRUST_POLICY section 17).
 */

export type AddressInput = {
  line1: string
  line2?: string | undefined
  city: string
  region: string
  postalCode: string
}

export type GeocodeSuccess = {
  ok: true
  latitude: number
  longitude: number
  normalizedAddress: string
  provider: string
}

export type GeocodeFailure = {
  ok: false
  code: 'NO_MATCH' | 'AMBIGUOUS' | 'PROVIDER_UNAVAILABLE' | 'UNSUPPORTED_COUNTRY'
}

export type GeocodeResult = GeocodeSuccess | GeocodeFailure

export interface Geocoder {
  readonly name: string
  geocode(address: AddressInput, signal?: AbortSignal): Promise<GeocodeResult>
}

const CENSUS_URL = 'https://geocoding.geo.census.gov/geocoder/locations/address'
const TIMEOUT_MS = 8000

/**
 * US Census Bureau geocoder.
 *
 * Returns NO_MATCH rather than a best guess when it cannot place an address.
 * A wrong coordinate is worse than no coordinate here: it decides whether a
 * customer is inside a provider's service area, so a confident mistake puts
 * a teenager on a street they never agreed to serve.
 */
export class CensusGeocoder implements Geocoder {
  readonly name = 'us_census'

  async geocode(address: AddressInput, signal?: AbortSignal): Promise<GeocodeResult> {
    const params = new URLSearchParams({
      street: address.line1,
      city: address.city,
      state: address.region,
      zip: address.postalCode,
      benchmark: 'Public_AR_Current',
      format: 'json',
    })

    const timeout = AbortSignal.timeout(TIMEOUT_MS)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout

    let payload: unknown
    try {
      const res = await fetch(`${CENSUS_URL}?${params.toString()}`, { signal: combined })
      if (!res.ok) return { ok: false, code: 'PROVIDER_UNAVAILABLE' }
      payload = await res.json()
    } catch {
      // Deliberately no address in this log line.
      console.error('[geocoder] census request failed')
      return { ok: false, code: 'PROVIDER_UNAVAILABLE' }
    }

    const matches = (payload as { result?: { addressMatches?: unknown[] } })?.result?.addressMatches
    if (!Array.isArray(matches) || matches.length === 0) return { ok: false, code: 'NO_MATCH' }

    // More than one match means the input did not identify a single house.
    // Picking the first would silently choose a neighbour's address.
    if (matches.length > 1) return { ok: false, code: 'AMBIGUOUS' }

    const m = matches[0] as {
      matchedAddress?: string
      coordinates?: { x?: number; y?: number }
    }
    const lat = m.coordinates?.y
    const lng = m.coordinates?.x
    if (typeof lat !== 'number' || typeof lng !== 'number') return { ok: false, code: 'NO_MATCH' }

    return {
      ok: true,
      latitude: lat,
      longitude: lng,
      normalizedAddress: m.matchedAddress ?? '',
      provider: this.name,
    }
  }
}

/** A fixed-response geocoder for tests, so suites never depend on a network call. */
export class StubGeocoder implements Geocoder {
  readonly name = 'stub'
  constructor(private readonly responses: Map<string, GeocodeResult>) {}

  static keyFor(a: AddressInput): string {
    return `${a.line1}|${a.city}|${a.region}|${a.postalCode}`.toLowerCase()
  }

  async geocode(address: AddressInput): Promise<GeocodeResult> {
    return this.responses.get(StubGeocoder.keyFor(address)) ?? { ok: false, code: 'NO_MATCH' }
  }
}

let defaultGeocoder: Geocoder = new CensusGeocoder()

export function getGeocoder(): Geocoder {
  return defaultGeocoder
}

/** Test seam. Swapping the vendor in production means changing this default. */
export function setGeocoder(g: Geocoder): void {
  defaultGeocoder = g
}
