/**
 * Checkout against the live database.
 *
 * Covers the two things that decide whether a customer can subscribe -- is
 * the address covered, and is there room on the route -- plus the invariant
 * that matters most afterwards: the price the customer agreed to is frozen
 * on the subscription and does not move when the provider changes theirs.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'
import { previewCheckout, createSubscription } from '@/server/checkoutService'
import { StubGeocoder, setGeocoder, type GeocodeResult } from '@/server/geocoder'

const url = process.env['NEXT_PUBLIC_SUPABASE_URL']!
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY']!
const admin = createClient<Database>(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const stamp = Date.now()

const AREA = {
  type: 'Polygon',
  coordinates: [
    [
      [-97.755, 30.26],
      [-97.73, 30.26],
      [-97.73, 30.29],
      [-97.755, 30.29],
      [-97.755, 30.26],
    ],
  ],
}

const INSIDE = {
  line1: '100 Inside St',
  city: 'Austin',
  region: 'TX',
  postalCode: '78701',
  countryCode: 'US',
}
const OUTSIDE = { ...INSIDE, line1: '900 Outside Ave', postalCode: '78702' }

function stub(): StubGeocoder {
  const m = new Map<string, GeocodeResult>()
  m.set(StubGeocoder.keyFor(INSIDE), {
    ok: true,
    latitude: 30.275,
    longitude: -97.7425,
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
  return new StubGeocoder(m)
}

let providerId = ''
let customerId = ''
let secondCustomerId = ''
let serviceId = ''
let subscriptionId = ''

async function makeUser(email: string): Promise<string> {
  const { data: created } = await admin.auth.admin.createUser({
    email,
    password: `Test-${stamp}-Aa1!`,
    email_confirm: true,
  })
  const { data: du } = await admin
    .from('users')
    .select('id')
    .eq('auth_user_id', created!.user!.id)
    .single()
  return du!.id
}

beforeAll(async () => {
  setGeocoder(stub())

  providerId = await makeUser(`co-provider-${stamp}@example.com`)
  customerId = await makeUser(`co-customer-${stamp}@example.com`)
  secondCustomerId = await makeUser(`co-customer2-${stamp}@example.com`)

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
      name: `Checkout Test ${stamp}`,
      slug: `checkout-test-${stamp}`,
      state: 'published',
      published_at: new Date().toISOString(),
      public_area_label: 'Downtown',
    })
    .select('id')
    .single()

  const { data: cat } = await admin
    .from('service_catalog')
    .select('id')
    .eq('code', 'bin_curb_service')
    .single()

  const { data: svc } = await admin
    .from('provider_services')
    .insert({
      business_id: biz!.id,
      catalog_service_id: cat!.id,
      slug: 'weekly-bins',
      public_name: 'Weekly bins',
      description: 'A description long enough to satisfy the constraint.',
      price_cents: 300,
      price_unit: 'week',
      billing_cycle_weeks: 4,
      schedule_rule: {
        frequency: 'weekly',
        weekdays: ['tuesday'],
        timezone: 'America/Chicago',
        windowStart: '08:00',
        windowEnd: '18:00',
      },
      capacity_rule: { maxAddresses: 2 },
      state: 'active',
    })
    .select('id')
    .single()
  serviceId = svc!.id

  await admin.from('service_areas').insert({
    provider_service_id: serviceId,
    private_geometry: AREA,
  })
})

afterAll(async () => {
  // subscriptions.customer_user_id is ON DELETE RESTRICT on purpose --
  // TECHNICAL_SPEC section 23 requires user deletion to honour financial
  // retention -- so the financial rows have to go first or the user delete
  // silently fails and leaves everything behind.
  const ids = [customerId, secondCustomerId, providerId].filter(Boolean)
  const { data: subs } = await admin
    .from('subscriptions')
    .select('id')
    .in('customer_user_id', ids)
  const subIds = (subs ?? []).map((s) => s.id)

  if (subIds.length) {
    await admin.from('service_occurrences').delete().in('subscription_id', subIds)
    await admin.from('ledger_entries').delete().in('subscription_id', subIds)
    await admin.from('subscriptions').delete().in('id', subIds)
  }
  await admin.from('customer_addresses').delete().in('customer_user_id', ids)

  for (const id of ids) {
    const { data: u } = await admin
      .from('users')
      .select('auth_user_id')
      .eq('id', id)
      .maybeSingle()
    await admin.from('audit_log').delete().eq('actor_user_id', id)
    await admin.from('users').delete().eq('id', id)
    if (u?.auth_user_id) await admin.auth.admin.deleteUser(u.auth_user_id).catch(() => {})
  }
})

const NOW = new Date('2026-09-01T12:00:00Z') // a Tuesday

describe('preview', () => {
  it('prices the cycle exactly as the spec example does', async () => {
    const r = await previewCheckout({
      db: admin,
      input: { providerServiceId: serviceId, address: INSIDE },
      now: NOW,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.preview.eligible).toBe(true)
    expect(r.preview.quote.serviceSubtotalCents).toBe(1200)
    expect(r.preview.quote.platformFeeCents).toBe(180)
    expect(r.preview.quote.customerTotalCents).toBe(1380)
  })

  it('offers a start date that gives the provider notice', async () => {
    const r = await previewCheckout({
      db: admin,
      input: { providerServiceId: serviceId, address: INSIDE },
      now: NOW,
    })
    if (!r.ok) return
    // NOW is Tuesday 2026-09-01; with two days notice the first Tuesday
    // available is the 8th, not today.
    expect(r.preview.earliestStartDate).toBe('2026-09-08')
  })

  it('lists the service dates the first cycle actually covers', async () => {
    const r = await previewCheckout({
      db: admin,
      input: { providerServiceId: serviceId, address: INSIDE },
      now: NOW,
    })
    if (!r.ok) return
    expect(r.preview.firstCycleDates).toEqual([
      '2026-09-08',
      '2026-09-15',
      '2026-09-22',
      '2026-09-29',
    ])
  })

  it('reports an uncovered address without refusing the request', async () => {
    // Coverage is an answer, not an error -- the page needs to say "not this
    // one" rather than fail.
    const r = await previewCheckout({
      db: admin,
      input: { providerServiceId: serviceId, address: OUTSIDE },
      now: NOW,
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.preview.eligible).toBe(false)
  })
})

describe('creating a subscription', () => {
  it('refuses an address outside the area', async () => {
    const r = await createSubscription({
      db: admin,
      customerUserId: customerId,
      input: {
        providerServiceId: serviceId,
        address: OUTSIDE,
        adultAttestation: true,
      },
      now: NOW,
    })
    expect(r).toEqual({ ok: false, code: 'NOT_ELIGIBLE' })
  })

  it('creates a pending subscription with occurrences for the first cycle', async () => {
    const r = await createSubscription({
      db: admin,
      customerUserId: customerId,
      input: {
        providerServiceId: serviceId,
        address: INSIDE,
        adultAttestation: true,
        customerInstructions: 'Bins live on the left side of the garage.',
      },
      now: NOW,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    subscriptionId = r.subscriptionId
    // Pending, not active: no money has moved yet, and a half-finished
    // checkout must not put a stranger on the route.
    expect(r.state).toBe('pending')
    expect(r.startDate).toBe('2026-09-08')
    expect(r.occurrenceCount).toBe(4)
  })

  it('generates occurrences on the right dates with the right value', async () => {
    const { data } = await admin
      .from('service_occurrences')
      .select('service_date, state, service_value_cents, local_timezone, service_window_start')
      .eq('subscription_id', subscriptionId)
      .order('service_date')

    expect((data ?? []).map((o) => o.service_date)).toEqual([
      '2026-09-08',
      '2026-09-15',
      '2026-09-22',
      '2026-09-29',
    ])
    for (const o of data ?? []) {
      expect(o.state).toBe('scheduled')
      expect(o.service_value_cents).toBe(300)
      expect(o.local_timezone).toBe('America/Chicago')
      expect(o.service_window_start).toBe('08:00:00')
    }
  })

  it('freezes the price and fee terms at signup', async () => {
    // A provider raising their price must not silently reprice an existing
    // customer. PRD section 12 sells reliability.
    await admin.from('provider_services').update({ price_cents: 900 }).eq('id', serviceId)

    const { data } = await admin
      .from('subscriptions')
      .select('provider_price_cents, platform_fee_bps, platform_fee_min_cents, billing_cycle_weeks')
      .eq('id', subscriptionId)
      .single()

    expect(data?.provider_price_cents).toBe(300)
    expect(data?.platform_fee_bps).toBe(1500)
    expect(data?.platform_fee_min_cents).toBe(100)

    await admin.from('provider_services').update({ price_cents: 300 }).eq('id', serviceId)
  })

  it('refuses a duplicate subscription for the same customer, service and address', async () => {
    // This is why addresses are deduplicated. Inserting a fresh address row
    // per checkout meant the unique index never matched, and a second
    // Subscribe click produced a second subscription and a second bill.
    const r = await createSubscription({
      db: admin,
      customerUserId: customerId,
      input: { providerServiceId: serviceId, address: INSIDE, adultAttestation: true },
      now: NOW,
    })
    expect(r).toEqual({ ok: false, code: 'ALREADY_SUBSCRIBED' })

    const { count } = await admin
      .from('subscriptions')
      .select('id', { count: 'exact', head: true })
      .eq('customer_user_id', customerId)
    expect(count).toBe(1)
  })

  it('reuses the existing address rather than storing it twice', async () => {
    const { count } = await admin
      .from('customer_addresses')
      .select('id', { count: 'exact', head: true })
      .eq('customer_user_id', customerId)
    expect(count).toBe(1)
  })

  it('refuses a start date earlier than the notice window allows', async () => {
    const r = await createSubscription({
      db: admin,
      customerUserId: secondCustomerId,
      input: {
        providerServiceId: serviceId,
        address: INSIDE,
        adultAttestation: true,
        startDate: '2026-09-01',
      },
      now: NOW,
    })
    expect(r).toEqual({ ok: false, code: 'INVALID_START_DATE' })
  })

  it('refuses a start date the schedule does not offer', async () => {
    const r = await createSubscription({
      db: admin,
      customerUserId: secondCustomerId,
      input: {
        providerServiceId: serviceId,
        address: INSIDE,
        adultAttestation: true,
        startDate: '2026-09-09', // a Wednesday
      },
      now: NOW,
    })
    expect(r).toEqual({ ok: false, code: 'INVALID_START_DATE' })
  })
})

describe('capacity', () => {
  it('reports a full route rather than silently accepting', async () => {
    // The service caps at 2 addresses and one live subscription exists.
    const before = await previewCheckout({
      db: admin,
      input: { providerServiceId: serviceId, address: INSIDE },
      now: NOW,
    })
    if (before.ok) expect(before.preview.atCapacity).toBe(false)

    const second = await createSubscription({
      db: admin,
      customerUserId: secondCustomerId,
      input: { providerServiceId: serviceId, address: INSIDE, adultAttestation: true },
      now: NOW,
    })
    expect(second.ok).toBe(true)

    const after = await previewCheckout({
      db: admin,
      input: { providerServiceId: serviceId, address: INSIDE },
      now: NOW,
    })
    if (after.ok) expect(after.preview.atCapacity).toBe(true)
  })

  it('refuses a new subscription once the route is full', async () => {
    const third = await createSubscription({
      db: admin,
      customerUserId: providerId, // any third party
      input: { providerServiceId: serviceId, address: INSIDE, adultAttestation: true },
      now: NOW,
    })
    expect(third).toEqual({ ok: false, code: 'AT_CAPACITY' })
  })
})

describe('an unpublished service cannot be subscribed to', () => {
  it('refuses once the business is paused', async () => {
    await admin
      .from('businesses')
      .update({ state: 'paused_guardian' })
      .eq('slug', `checkout-test-${stamp}`)

    const r = await previewCheckout({
      db: admin,
      input: { providerServiceId: serviceId, address: INSIDE },
      now: NOW,
    })
    expect(r).toEqual({ ok: false, code: 'SERVICE_NOT_FOUND' })

    await admin
      .from('businesses')
      .update({ state: 'published' })
      .eq('slug', `checkout-test-${stamp}`)
  })
})
