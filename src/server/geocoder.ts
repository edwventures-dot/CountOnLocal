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

/**
 * How long to wait for one attempt.
 *
 * Was 8000, which was below what the service actually took on a bad day.
 * Measured on 2026-08-31: three consecutive requests at 9.2s, 10.3s and
 * 9.2s, one of them a 502 -- so every address check failed, and a customer
 * typing their own address got "we could not check that right now" with no
 * way to tell that it was not their fault.
 *
 * The normal case is nowhere near this: the same endpoint answered in 0.27s
 * a few hours earlier. This ceiling exists for the degraded day, not the
 * ordinary one.
 */
const TIMEOUT_MS = 15_000

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

    const url = `${CENSUS_URL}?${params.toString()}`

    /**
     * One attempt. Distinguishes a fast refusal from a slow one, because
     * only one of them is worth repeating.
     */
    const attempt = async (): Promise<
      { ok: true; payload: unknown } | { ok: false; retryable: boolean }
    > => {
      const timeout = AbortSignal.timeout(TIMEOUT_MS)
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
      try {
        const res = await fetch(url, { signal: combined })
        // A 5xx is the service having a moment and is worth one more go.
        // A 4xx is about the request and will fail identically.
        if (!res.ok) return { ok: false, retryable: res.status >= 500 }
        return { ok: true, payload: await res.json() }
      } catch {
        // A timeout or a dropped connection. Deliberately not retried: the
        // caller has already waited the full budget, and a second wait of
        // the same length is worse for them than an error they can act on.
        return { ok: false, retryable: false }
      }
    }

    let payload: unknown
    const first = await attempt()
    if (first.ok) {
      payload = first.payload
    } else if (first.retryable) {
      // Immediate, because a 5xx comes back fast and the whole cost of
      // this retry is one more round trip.
      const second = await attempt()
      if (!second.ok) {
        // Deliberately no address in this log line.
        console.error('[geocoder] census request failed after a retry')
        return { ok: false, code: 'PROVIDER_UNAVAILABLE' }
      }
      payload = second.payload
    } else {
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
