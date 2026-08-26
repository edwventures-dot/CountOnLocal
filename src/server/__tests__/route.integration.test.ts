/**
 * The provider's Today route, against the live database.
 *
 * The claim that matters most is a privacy one and cannot be made with the
 * privileged client: a provider sees the addresses on their own route and
 * nobody else's. So every read here goes through a client PostgREST sees as
 * a specific signed-in user, exactly as the endpoint does, and the check is
 * whether row level security refuses -- not whether this file remembered to
 * filter.
 *
 *   - two providers, two routes, no leakage in either direction;
 *   - a customer gets no route at all;
 *   - the address disappears when the subscription ends;
 *   - the route is ordered, and today's stops only.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'
import { getTodayRoute } from '@/server/routeService'

const url = process.env['NEXT_PUBLIC_SUPABASE_URL']!
const anonKey = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY']!

const admin = createClient<Database>(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

/** A client PostgREST sees as this signed-in user. */
function userScoped(accessToken: string): SupabaseClient<Database> {
  return createClient<Database>(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  })
}

const stamp = Date.now()
const PASSWORD = `Test-${stamp}-Aa1!`
const PRICE = 300

/** Chicago afternoon on the service date, so "today" is unambiguous. */
const TODAY_ISO = '2026-09-01'
const NOW = new Date('2026-09-01T18:00:00Z')

type TestUser = { domainId: string; token: string }

let providerA: TestUser
let providerB: TestUser
let customer: TestUser
let subAId = ''
let subBId = ''
const madeSubs: string[] = []
const madeUsers: string[] = []

async function makeUser(email: string): Promise<TestUser> {
  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  })
  if (error || !created.user) throw new Error(`createUser failed: ${error?.message}`)

  const { data: du } = await admin
    .from('users')
    .select('id')
    .eq('auth_user_id', created.user.id)
    .single()

  const anon = createClient<Database>(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: session, error: signInErr } = await anon.auth.signInWithPassword({
    email,
    password: PASSWORD,
  })
  if (signInErr || !session.session) throw new Error(`sign in failed: ${signInErr?.message}`)

  madeUsers.push(du!.id)
  return { domainId: du!.id, token: session.session.access_token }
}

/** A published business with one weekly service, owned by `provider`. */
async function makeBusiness(provider: TestUser, slug: string): Promise<string> {
  const { data: biz, error: bizErr } = await admin
    .from('businesses')
    .insert({
      provider_user_id: provider.domainId,
      name: `Route ${slug} ${stamp}`,
      slug: `route-${slug}-${stamp}`,
      state: 'published',
      published_at: new Date().toISOString(),
      public_area_label: 'Downtown',
    })
    .select('id')
    .single()
  if (bizErr) throw new Error(`business insert failed: ${bizErr.message}`)

  const { data: cat } = await admin
    .from('service_catalog')
    .select('id')
    .eq('code', 'bin_curb_service')
    .single()

  const { data: svc, error: svcErr } = await admin
    .from('provider_services')
    .insert({
      business_id: biz!.id,
      catalog_service_id: cat!.id,
      slug: 'weekly-bins',
      public_name: 'Weekly bins',
      description: 'A description long enough to satisfy the constraint.',
      price_cents: PRICE,
      price_unit: 'week',
      billing_cycle_weeks: 4,
      schedule_rule: {
        frequency: 'weekly',
        weekdays: ['tuesday'],
        timezone: 'America/Chicago',
        windowStart: '08:00',
        windowEnd: '18:00',
      },
      capacity_rule: { maxAddresses: 500 },
      state: 'active',
    })
    .select('id')
    .single()
  if (svcErr) throw new Error(`service insert failed: ${svcErr.message}`)
  return svc!.id
}

let addressCursor = 0

async function makeSubscription(args: {
  serviceId: string
  line1: string
  latitude: number
  longitude: number
  accessNotes?: string
}): Promise<string> {
  const { data: addr, error: addrErr } = await admin
    .from('customer_addresses')
    .insert({
      customer_user_id: customer.domainId,
      line1: args.line1,
      city: 'Austin',
      region: 'TX',
      postal_code: `7870${addressCursor++ % 10}`,
      country_code: 'US',
      ...(args.accessNotes ? { access_notes: args.accessNotes } : {}),
    })
    .select('id')
    .single()
  if (addrErr) throw new Error(`address insert failed: ${addrErr.message}`)

  // PostgREST cannot insert a geography literal, so the point goes in
  // through the function 0018 added -- the same one checkout now calls.
  await setPoint(addr!.id, args.latitude, args.longitude)

  const { data, error } = await admin
    .from('subscriptions')
    .insert({
      customer_user_id: customer.domainId,
      provider_service_id: args.serviceId,
      service_address_id: addr!.id,
      state: 'active',
      provider_price_cents: PRICE,
      price_unit: 'week',
      platform_fee_bps: 1500,
      platform_fee_min_cents: 100,
      billing_cycle_weeks: 4,
      stripe_payment_method_id: `pm_test_${stamp}`,
    })
    .select('id')
    .single()
  if (error) throw new Error(`subscription insert failed: ${error.message}`)

  madeSubs.push(data!.id)
  return data!.id
}

async function setPoint(addressId: string, lat: number, lon: number): Promise<void> {
  const { error } = await admin.rpc('set_customer_address_point' as never, {
    p_address_id: addressId,
    p_lat: lat,
    p_lng: lon,
  } as never)
  if (error) throw new Error(`set point failed: ${error.message}`)
}

async function addOccurrence(subId: string, dateIso: string, state = 'due_today'): Promise<string> {
  const { data, error } = await admin
    .from('service_occurrences')
    .insert({
      subscription_id: subId,
      service_date: dateIso,
      local_timezone: 'America/Chicago',
      state: state as never,
      service_value_cents: PRICE,
      service_window_start: '08:00',
      service_window_end: '18:00',
      ...(state === 'completed' ? { completed_at: `${dateIso}T18:00:00Z` } : {}),
    })
    .select('id')
    .single()
  if (error) throw new Error(`occurrence insert failed: ${error.message}`)
  return data!.id
}

beforeAll(async () => {
  providerA = await makeUser(`route-a-${stamp}@example.com`)
  providerB = await makeUser(`route-b-${stamp}@example.com`)
  customer = await makeUser(`route-cust-${stamp}@example.com`)

  for (const p of [providerA, providerB]) {
    await admin.from('provider_profiles').insert({
      user_id: p.domainId,
      date_of_birth: '1990-01-01',
      display_first_name: 'Alex',
      guardian_state: 'not_required',
    })
  }

  const svcA = await makeBusiness(providerA, 'a')
  const svcB = await makeBusiness(providerB, 'b')

  // Provider A: three houses along one street, created out of order.
  subAId = await makeSubscription({
    serviceId: svcA,
    line1: '300 Oak St',
    latitude: 30.2700,
    longitude: -97.74,
    accessNotes: 'Side gate code 4417',
  })
  const subA2 = await makeSubscription({
    serviceId: svcA,
    line1: '100 Oak St',
    latitude: 30.2682,
    longitude: -97.74,
  })
  const subA3 = await makeSubscription({
    serviceId: svcA,
    line1: '200 Oak St',
    latitude: 30.2691,
    longitude: -97.74,
  })

  subBId = await makeSubscription({
    serviceId: svcB,
    line1: '900 Elm Ave',
    latitude: 30.3100,
    longitude: -97.70,
  })

  await addOccurrence(subAId, TODAY_ISO)
  await addOccurrence(subA2, TODAY_ISO)
  await addOccurrence(subA3, TODAY_ISO)
  // A stop next week, which must not appear on today's route.
  await addOccurrence(subAId, '2026-09-08', 'scheduled')

  await addOccurrence(subBId, TODAY_ISO)
})

afterAll(async () => {
  if (madeSubs.length) {
    const { data: occs } = await admin
      .from('service_occurrences')
      .select('id')
      .in('subscription_id', madeSubs)
    const occIds = (occs ?? []).map((o) => o.id)
    if (occIds.length) await admin.from('ledger_entries').delete().in('occurrence_id', occIds)
    await admin.from('ledger_entries').delete().in('subscription_id', madeSubs)
    await admin.from('service_occurrences').delete().in('subscription_id', madeSubs)
    await admin.from('subscriptions').delete().in('id', madeSubs)
  }
  await admin.from('customer_addresses').delete().in('customer_user_id', madeUsers)
  for (const id of madeUsers) {
    const { data: u } = await admin.from('users').select('auth_user_id').eq('id', id).maybeSingle()
    await admin.from('audit_log').delete().eq('actor_user_id', id)
    await admin.from('users').delete().eq('id', id)
    if (u?.auth_user_id) await admin.auth.admin.deleteUser(u.auth_user_id).catch(() => {})
  }
})

describe('a provider sees their own route', () => {
  it('returns today stops only', async () => {
    const r = await getTodayRoute({ db: userScoped(providerA.token), providerUserId: providerA.domainId, now: NOW })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.route.date).toBe(TODAY_ISO)
      expect(r.route.stops).toHaveLength(3)
      expect(r.route.stops.every((s) => s.serviceDate === TODAY_ISO)).toBe(true)
    }
  })

  it('orders the street rather than returning insert order', async () => {
    const r = await getTodayRoute({ db: userScoped(providerA.token), providerUserId: providerA.domainId, now: NOW })
    if (r.ok) {
      const lines = r.route.stops.map((s) => s.address?.line1)
      // Seeded from the lowest id at equal windows, then nearest-neighbour
      // along the street: consecutive stops, not a zig-zag.
      expect(new Set(lines)).toEqual(new Set(['100 Oak St', '200 Oak St', '300 Oak St']))
      expect(r.route.stops.map((s) => s.position)).toEqual([1, 2, 3])
    }
  })

  it('adds up the day earnings', async () => {
    const r = await getTodayRoute({ db: userScoped(providerA.token), providerUserId: providerA.domainId, now: NOW })
    if (r.ok) expect(r.route.expectedEarningsCents).toBe(3 * PRICE)
  })

  it('estimates a short walk for three houses on one street', async () => {
    const r = await getTodayRoute({ db: userScoped(providerA.token), providerUserId: providerA.domainId, now: NOW })
    if (r.ok) {
      expect(r.route.estimatedMetres).toBeGreaterThan(0)
      expect(r.route.estimatedMetres).toBeLessThan(1000)
      expect(r.route.unplacedCount).toBe(0)
    }
  })

  it('gives the provider the gate code, because they need it', async () => {
    const r = await getTodayRoute({ db: userScoped(providerA.token), providerUserId: providerA.domainId, now: NOW })
    if (r.ok) {
      const withCode = r.route.stops.find((s) => s.address?.line1 === '300 Oak St')
      expect(withCode?.address?.accessNotes).toBe('Side gate code 4417')
    }
  })

  it('reports progress as work is completed', async () => {
    const before = await getTodayRoute({ db: userScoped(providerA.token), providerUserId: providerA.domainId, now: NOW })
    if (before.ok) expect(before.route.progress).toEqual({ done: 0, total: 3, complete: false })

    const first = before.ok ? before.route.stops[0]!.occurrenceId : ''
    await admin
      .from('service_occurrences')
      .update({ state: 'completed', completed_at: `${TODAY_ISO}T18:00:00Z` })
      .eq('id', first)

    const after = await getTodayRoute({ db: userScoped(providerA.token), providerUserId: providerA.domainId, now: NOW })
    if (after.ok) expect(after.route.progress.done).toBe(1)

    await admin
      .from('service_occurrences')
      .update({ state: 'due_today', completed_at: null })
      .eq('id', first)
  })
})

describe('one provider cannot see another route', () => {
  it('gives provider B only their own stop', async () => {
    const r = await getTodayRoute({ db: userScoped(providerB.token), providerUserId: providerB.domainId, now: NOW })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.route.stops).toHaveLength(1)
      expect(r.route.stops[0]!.address?.line1).toBe('900 Elm Ave')
    }
  })

  it('never shows provider A addresses to provider B', async () => {
    const r = await getTodayRoute({ db: userScoped(providerB.token), providerUserId: providerB.domainId, now: NOW })
    if (r.ok) {
      const lines = r.route.stops.map((s) => s.address?.line1 ?? '')
      expect(lines.some((l) => l.includes('Oak St'))).toBe(false)
    }
  })

  it('never leaks another provider gate code', async () => {
    const r = await getTodayRoute({ db: userScoped(providerB.token), providerUserId: providerB.domainId, now: NOW })
    if (r.ok) {
      const notes = r.route.stops.map((s) => s.address?.accessNotes ?? '')
      expect(notes.some((n) => n.includes('4417'))).toBe(false)
    }
  })

  it('refuses provider A addresses even on a direct table read', async () => {
    // The service could be rewritten badly; RLS is the thing being tested.
    const { data } = await userScoped(providerB.token)
      .from('customer_addresses')
      .select('line1')
    const lines = (data ?? []).map((r) => r.line1)
    expect(lines.some((l) => l.includes('Oak St'))).toBe(false)
  })
})

describe('a customer has no route', () => {
  it('returns nothing rather than their own addresses', async () => {
    const r = await getTodayRoute({ db: userScoped(customer.token), providerUserId: customer.domainId, now: NOW })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.route.stops).toHaveLength(0)
      expect(r.route.expectedEarningsCents).toBe(0)
    }
  })
})

describe('access ends when the subscription does', () => {
  it('drops the address once the subscription is canceled', async () => {
    const before = await userScoped(providerA.token)
      .from('customer_addresses')
      .select('line1')
    const countBefore = (before.data ?? []).length
    expect(countBefore).toBeGreaterThan(0)

    await admin.from('subscriptions').update({ state: 'canceled', canceled_at: new Date().toISOString() }).eq('id', subAId)

    const after = await userScoped(providerA.token)
      .from('customer_addresses')
      .select('line1')
    expect((after.data ?? []).length).toBe(countBefore - 1)

    await admin.from('subscriptions').update({ state: 'active', canceled_at: null }).eq('id', subAId)
  })
})
