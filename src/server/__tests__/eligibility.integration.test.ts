/**
 * Address eligibility against the live database and a real polygon.
 *
 * Geocoding runs through the stub so the suite does not depend on a network
 * call to the Census Bureau. The point-in-polygon half is real: it runs in
 * PostGIS against a real service area.
 *
 * One test does hit the live geocoder, marked as such, because an interface
 * that has never spoken to the real vendor is an interface that has never
 * been tested.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'
import { checkAddressEligibility, type AddressFields } from '@/server/eligibility'
import { CensusGeocoder, StubGeocoder, setGeocoder, type GeocodeResult } from '@/server/geocoder'

const url = process.env['NEXT_PUBLIC_SUPABASE_URL']!
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY']!
const admin = createClient<Database>(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const stamp = Date.now()
const PROVIDER_EMAIL = `elig-provider-${stamp}@example.com`

// A small square over part of downtown Austin.
const AREA = {
  type: 'Polygon',
  coordinates: [
    [
      [-97.75, 30.25],
      [-97.73, 30.25],
      [-97.73, 30.27],
      [-97.75, 30.27],
      [-97.75, 30.25],
    ],
  ],
}

const INSIDE: AddressFields = {
  line1: '100 Inside St',
  city: 'Austin',
  region: 'TX',
  postalCode: '78701',
  countryCode: 'US',
}
const OUTSIDE: AddressFields = {
  line1: '900 Outside Ave',
  city: 'Austin',
  region: 'TX',
  postalCode: '78702',
  countryCode: 'US',
}
const NOWHERE: AddressFields = {
  line1: '1 Nonexistent Rd',
  city: 'Austin',
  region: 'TX',
  postalCode: '78703',
  countryCode: 'US',
}
const DOUBLE: AddressFields = {
  line1: '2 Ambiguous Way',
  city: 'Austin',
  region: 'TX',
  postalCode: '78704',
  countryCode: 'US',
}

function stub(): StubGeocoder {
  const m = new Map<string, GeocodeResult>()
  m.set(StubGeocoder.keyFor(INSIDE), {
    ok: true,
    latitude: 30.26,
    longitude: -97.74,
    normalizedAddress: '100 INSIDE ST, AUSTIN, TX, 78701',
    provider: 'stub',
  })
  m.set(StubGeocoder.keyFor(OUTSIDE), {
    ok: true,
    latitude: 30.31,
    longitude: -97.6,
    normalizedAddress: '900 OUTSIDE AVE, AUSTIN, TX, 78702',
    provider: 'stub',
  })
  m.set(StubGeocoder.keyFor(NOWHERE), { ok: false, code: 'NO_MATCH' })
  m.set(StubGeocoder.keyFor(DOUBLE), { ok: false, code: 'AMBIGUOUS' })
  return new StubGeocoder(m)
}

let providerId = ''
let businessId = ''
let activeServiceId = ''
let draftServiceId = ''

beforeAll(async () => {
  setGeocoder(stub())

  const { data: created } = await admin.auth.admin.createUser({
    email: PROVIDER_EMAIL,
    password: `Test-${stamp}-Aa1!`,
    email_confirm: true,
  })
  const { data: du } = await admin
    .from('users')
    .select('id')
    .eq('auth_user_id', created!.user!.id)
    .single()
  providerId = du!.id

  await admin.from('provider_profiles').insert({
    user_id: providerId,
    date_of_birth: '1990-01-01',
    display_first_name: 'Alex',
    guardian_state: 'not_required',
  })

  const { data: biz } = await admin
    .from('businesses')
    .insert({
      provider_user_id: providerId,
      name: `Elig Test ${stamp}`,
      slug: `elig-test-${stamp}`,
      state: 'published',
      published_at: new Date().toISOString(),
      public_area_label: 'Downtown',
    })
    .select('id')
    .single()
  businessId = biz!.id

  const { data: cat } = await admin
    .from('service_catalog')
    .select('id')
    .eq('code', 'bin_curb_service')
    .single()

  for (const [slug, state] of [
    ['active-svc', 'active'],
    ['draft-svc', 'draft'],
  ] as const) {
    const { data: svc } = await admin
      .from('provider_services')
      .insert({
        business_id: businessId,
        catalog_service_id: cat!.id,
        slug,
        public_name: slug,
        description: 'A description long enough to satisfy the constraint.',
        price_cents: 300,
        price_unit: 'week',
        schedule_rule: { weekday: 'tuesday' },
        capacity_rule: { maxAddresses: 30 },
        state,
      })
      .select('id')
      .single()

    await admin.from('service_areas').insert({
      provider_service_id: svc!.id,
      private_geometry: AREA,
    })

    if (state === 'active') activeServiceId = svc!.id
    else draftServiceId = svc!.id
  }
})

afterAll(async () => {
  if (providerId) {
    const { data: u } = await admin
      .from('users')
      .select('auth_user_id')
      .eq('id', providerId)
      .maybeSingle()
    await admin.from('users').delete().eq('id', providerId)
    if (u?.auth_user_id) await admin.auth.admin.deleteUser(u.auth_user_id).catch(() => {})
  }
})

describe('coverage', () => {
  it('says yes for an address inside the area', async () => {
    const r = await checkAddressEligibility({
      db: admin,
      providerServiceId: activeServiceId,
      address: INSIDE,
    })
    expect(r).toEqual({
      ok: true,
      eligible: true,
      normalizedAddress: '100 INSIDE ST, AUSTIN, TX, 78701',
    })
  })

  it('says no for an address outside it', async () => {
    const r = await checkAddressEligibility({
      db: admin,
      providerServiceId: activeServiceId,
      address: OUTSIDE,
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.eligible).toBe(false)
  })

  it('returns the normalized address either way, so the customer can confirm what we matched', async () => {
    const r = await checkAddressEligibility({
      db: admin,
      providerServiceId: activeServiceId,
      address: OUTSIDE,
    })
    if (r.ok) expect(r.normalizedAddress).toContain('OUTSIDE AVE')
  })
})

describe('the answer reveals nothing but yes or no', () => {
  it('returns no geometry, distance, or neighbour information', async () => {
    const r = await checkAddressEligibility({
      db: admin,
      providerServiceId: activeServiceId,
      address: INSIDE,
    })
    const serialized = JSON.stringify(r)
    expect(serialized).not.toContain('Polygon')
    expect(serialized).not.toContain('coordinates')
    expect(serialized).not.toMatch(/-97\.7/)
    expect(Object.keys(r).sort()).toEqual(['eligible', 'normalizedAddress', 'ok'])
  })
})

describe('unpublished and draft services are simply not found', () => {
  it('refuses a draft service without saying it exists', async () => {
    const r = await checkAddressEligibility({
      db: admin,
      providerServiceId: draftServiceId,
      address: INSIDE,
    })
    expect(r).toEqual({ ok: false, code: 'SERVICE_NOT_FOUND' })
  })

  it('refuses once the business is unpublished', async () => {
    await admin.from('businesses').update({ state: 'paused_guardian' }).eq('id', businessId)
    const r = await checkAddressEligibility({
      db: admin,
      providerServiceId: activeServiceId,
      address: INSIDE,
    })
    expect(r).toEqual({ ok: false, code: 'SERVICE_NOT_FOUND' })

    await admin.from('businesses').update({ state: 'published' }).eq('id', businessId)
  })

  it('refuses an unknown service id', async () => {
    const r = await checkAddressEligibility({
      db: admin,
      providerServiceId: '00000000-0000-4000-8000-000000000000',
      address: INSIDE,
    })
    expect(r).toEqual({ ok: false, code: 'SERVICE_NOT_FOUND' })
  })
})

describe('bad addresses', () => {
  it('reports an address the geocoder cannot place', async () => {
    const r = await checkAddressEligibility({
      db: admin,
      providerServiceId: activeServiceId,
      address: NOWHERE,
    })
    expect(r).toEqual({ ok: false, code: 'ADDRESS_NOT_FOUND' })
  })

  it('refuses an ambiguous match rather than guessing a neighbour', async () => {
    const r = await checkAddressEligibility({
      db: admin,
      providerServiceId: activeServiceId,
      address: DOUBLE,
    })
    expect(r).toEqual({ ok: false, code: 'ADDRESS_AMBIGUOUS' })
  })

  it('refuses a non-US address before spending a geocoder call', async () => {
    const r = await checkAddressEligibility({
      db: admin,
      providerServiceId: activeServiceId,
      address: { ...INSIDE, countryCode: 'CA' },
    })
    expect(r).toEqual({ ok: false, code: 'UNSUPPORTED_COUNTRY' })
  })
})

describe('the real Census geocoder', () => {
  it('resolves a known address', async () => {
    // Hits the live service. An interface that has never spoken to the real
    // vendor has never actually been tested.
    const r = await new CensusGeocoder().geocode({
      line1: '1600 Pennsylvania Ave NW',
      city: 'Washington',
      region: 'DC',
      postalCode: '20500',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.latitude).toBeCloseTo(38.9, 1)
    expect(r.longitude).toBeCloseTo(-77.0, 1)
    expect(r.normalizedAddress.toUpperCase()).toContain('PENNSYLVANIA')
  })

  it('returns NO_MATCH for nonsense rather than a best guess', async () => {
    const r = await new CensusGeocoder().geocode({
      line1: '99999 Nowhere Street That Does Not Exist',
      city: 'Nowhereville',
      region: 'TX',
      postalCode: '00000',
    })
    expect(r.ok).toBe(false)
  })
})
