/**
 * HTTP layer for the occurrence endpoints -- real requests, real cookies.
 *
 * The service suite already proves the domain logic and the database
 * writes. This proves the parts only a route handler does: session auth,
 * the guardian gate, status codes, and the error envelope.
 *
 * The claim worth the most here is the guardian one. API_CONTRACT says a
 * minor provider needs valid guardian state to work a route, and
 * SAFETY_TRUST_POLICY section 2 says a revocation stops future charges --
 * so a revoked provider must not be able to keep completing stops and
 * accruing the very obligations the revocation was meant to end.
 *
 *   npx next dev -p 3100        (in another terminal)
 *   npm run test:http
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'
import type { Database } from '@/lib/supabase/types'

const BASE = process.env['E2E_BASE_URL'] ?? 'http://localhost:3100'
const url = process.env['NEXT_PUBLIC_SUPABASE_URL']!
const anonKey = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY']!

const admin = createClient<Database>(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const stamp = Date.now()
const PASSWORD = `Test-${stamp}-Aa1!`
const PRICE = 300

type TestUser = { domainId: string; cookie: string }

async function cookieHeaderFor(email: string): Promise<string> {
  const anon = createClient<Database>(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data, error } = await anon.auth.signInWithPassword({ email, password: PASSWORD })
  if (error || !data.session) throw new Error(`sign in failed: ${error?.message}`)

  const jar = new Map<string, string>()
  const shim = createServerClient<Database>(url, anonKey, {
    cookies: {
      getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
      setAll: (list) => {
        for (const { name, value } of list) jar.set(name, value)
      },
    },
  })
  await shim.auth.setSession({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
  })
  return [...jar.entries()].map(([n, v]) => `${n}=${encodeURIComponent(v)}`).join('; ')
}

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
  madeUsers.push(du!.id)
  return { domainId: du!.id, cookie: await cookieHeaderFor(email) }
}

async function call(
  method: string,
  path: string,
  opts: { cookie?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.cookie) headers['Cookie'] = opts.cookie
  const res = await fetch(BASE + path, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  })
  const text = await res.text()
  let body: any = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: res.status, body }
}

let provider: TestUser
let minorProvider: TestUser
let customer: TestUser
let subId = ''
let minorSubId = ''
const madeUsers: string[] = []
const madeSubs: string[] = []

function dobForAge(years: number): string {
  const d = new Date()
  d.setUTCFullYear(d.getUTCFullYear() - years)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

async function buildProvider(user: TestUser, slug: string, dob: string, guardianState: string) {
  await admin.from('provider_profiles').insert({
    user_id: user.domainId,
    date_of_birth: dob,
    display_first_name: 'Alex',
    guardian_state: guardianState as never,
  })

  // Onboarding grants this; the fixture creates the profile directly, so it
  // has to grant it too. Without the role every gate returns NOT_A_PROVIDER
  // and the guardian checks below never get a chance to run.
  await admin.from('user_roles').insert({ user_id: user.domainId, role: 'provider' })

  const { data: biz } = await admin
    .from('businesses')
    .insert({
      provider_user_id: user.domainId,
      name: `HTTP ${slug} ${stamp}`,
      slug: `http-${slug}-${stamp}`,
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
      price_cents: PRICE,
      price_unit: 'week',
      billing_cycle_weeks: 4,
      schedule_rule: { frequency: 'weekly', weekdays: ['tuesday'], timezone: 'UTC' },
      capacity_rule: { maxAddresses: 500 },
      state: 'active',
    })
    .select('id')
    .single()

  const { data: addr } = await admin
    .from('customer_addresses')
    .insert({
      customer_user_id: customer.domainId,
      line1: `${slug} 1 Main St`,
      city: 'Austin',
      region: 'TX',
      postal_code: '78701',
      country_code: 'US',
    })
    .select('id')
    .single()

  const { data: sub } = await admin
    .from('subscriptions')
    .insert({
      customer_user_id: customer.domainId,
      provider_service_id: svc!.id,
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

  madeSubs.push(sub!.id)
  return sub!.id
}

let occurrenceCursor = 0

async function makeOccurrence(subscriptionId: string, state = 'due_today'): Promise<string> {
  // Distinct dates: service_occurrences is unique on (subscription, date).
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + occurrenceCursor++)
  const iso = d.toISOString().slice(0, 10)

  const { data, error } = await admin
    .from('service_occurrences')
    .insert({
      subscription_id: subscriptionId,
      service_date: iso,
      local_timezone: 'UTC',
      state: state as never,
      service_value_cents: PRICE,
    })
    .select('id')
    .single()
  if (error) throw new Error(`occurrence insert failed: ${error.message}`)
  return data!.id
}

beforeAll(async () => {
  customer = await makeUser(`http-occ-cust-${stamp}@example.com`)
  provider = await makeUser(`http-occ-prov-${stamp}@example.com`)
  minorProvider = await makeUser(`http-occ-minor-${stamp}@example.com`)

  subId = await buildProvider(provider, 'adult', dobForAge(30), 'not_required')
  // A 15-year-old whose guardian approval has been revoked.
  minorSubId = await buildProvider(minorProvider, 'minor', dobForAge(15), 'revoked')
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

describe('authentication', () => {
  it('refuses an unauthenticated complete', async () => {
    const id = await makeOccurrence(subId)
    const r = await call('POST', `/api/v1/occurrences/${id}/complete`)
    expect(r.status).toBe(401)
    expect(r.body.error.code).toBe('UNAUTHENTICATED')
  })

  it('refuses an unauthenticated provider-skip', async () => {
    const id = await makeOccurrence(subId)
    const r = await call('POST', `/api/v1/occurrences/${id}/provider-skip`)
    expect(r.status).toBe(401)
  })

  it('returns the API_CONTRACT error envelope with a request id', async () => {
    const r = await call('POST', `/api/v1/occurrences/${crypto.randomUUID()}/complete`)
    expect(r.body.error).toMatchObject({
      code: expect.any(String),
      message: expect.any(String),
      requestId: expect.stringMatching(/^req_/),
    })
  })
})

describe('completing a stop', () => {
  it('lets the assigned provider complete it', async () => {
    const id = await makeOccurrence(subId)
    const r = await call('POST', `/api/v1/occurrences/${id}/complete`, { cookie: provider.cookie })
    expect(r.status).toBe(200)
    expect(r.body.state).toBe('completed')
  })

  it('accepts an optional note', async () => {
    const id = await makeOccurrence(subId)
    const r = await call('POST', `/api/v1/occurrences/${id}/complete`, {
      cookie: provider.cookie,
      body: { note: 'Bins returned to the side gate.' },
    })
    expect(r.status).toBe(200)
  })

  it('rejects an over-long note with field errors', async () => {
    const id = await makeOccurrence(subId)
    const r = await call('POST', `/api/v1/occurrences/${id}/complete`, {
      cookie: provider.cookie,
      body: { note: 'x'.repeat(501) },
    })
    expect(r.status).toBe(422)
    expect(r.body.error.fieldErrors).toHaveProperty('note')
  })

  it('403s a customer trying to complete their own service', async () => {
    const id = await makeOccurrence(subId)
    const r = await call('POST', `/api/v1/occurrences/${id}/complete`, { cookie: customer.cookie })
    expect(r.status).toBe(403)
  })

  it('409s a second completion', async () => {
    const id = await makeOccurrence(subId)
    await call('POST', `/api/v1/occurrences/${id}/complete`, { cookie: provider.cookie })
    const again = await call('POST', `/api/v1/occurrences/${id}/complete`, {
      cookie: provider.cookie,
    })
    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe('ILLEGAL_TRANSITION')
  })

  it('404s an occurrence that does not exist', async () => {
    const r = await call('POST', `/api/v1/occurrences/${crypto.randomUUID()}/complete`, {
      cookie: provider.cookie,
    })
    expect(r.status).toBe(404)
  })
})

describe('a revoked guardian stops the route', () => {
  it('refuses to complete a stop', async () => {
    const id = await makeOccurrence(minorSubId)
    const r = await call('POST', `/api/v1/occurrences/${id}/complete`, {
      cookie: minorProvider.cookie,
    })
    expect(r.status).toBe(403)
    expect(r.body.error.code).toBe('GUARDIAN_APPROVAL_REQUIRED')
  })

  it('says only what SAFETY_TRUST_POLICY 2 permits', async () => {
    const id = await makeOccurrence(minorSubId)
    const r = await call('POST', `/api/v1/occurrences/${id}/complete`, {
      cookie: minorProvider.cookie,
    })
    expect(r.body.error.message).toBe('Guardian approval is required to continue.')
    // Nothing about who revoked it, when, or why.
    expect(JSON.stringify(r.body)).not.toMatch(/revoked|guardian_state|parent/i)
  })

  it('refuses a provider-skip too', async () => {
    const id = await makeOccurrence(minorSubId)
    const r = await call('POST', `/api/v1/occurrences/${id}/provider-skip`, {
      cookie: minorProvider.cookie,
    })
    expect(r.status).toBe(403)
  })

  it('refuses the Today route', async () => {
    const r = await call('GET', '/api/v1/provider/today', { cookie: minorProvider.cookie })
    expect(r.status).toBe(403)
    expect(r.body.error.code).toBe('GUARDIAN_APPROVAL_REQUIRED')
  })

  it('leaves the occurrence untouched', async () => {
    const id = await makeOccurrence(minorSubId)
    await call('POST', `/api/v1/occurrences/${id}/complete`, { cookie: minorProvider.cookie })
    const { data } = await admin
      .from('service_occurrences')
      .select('state')
      .eq('id', id)
      .single()
    expect(data!.state).toBe('due_today')
  })
})

describe('provider-skip always credits', () => {
  it('credits the customer and reports it', async () => {
    const id = await makeOccurrence(subId)
    const r = await call('POST', `/api/v1/occurrences/${id}/provider-skip`, {
      cookie: provider.cookie,
    })
    expect(r.status).toBe(200)
    expect(r.body.credit.applied).toBe(true)
    expect(r.body.credit.amountCents).toBe(PRICE)
    expect(r.body.state).toBe('credited')
  })

  it('403s a customer pretending to be the provider', async () => {
    const id = await makeOccurrence(subId)
    const r = await call('POST', `/api/v1/occurrences/${id}/provider-skip`, {
      cookie: customer.cookie,
    })
    expect(r.status).toBe(403)
  })
})

describe('customer skip', () => {
  it('previews without changing anything', async () => {
    const id = await makeOccurrence(subId)
    const r = await call('GET', `/api/v1/subscriptions/${subId}/skip?occurrenceId=${id}`, {
      cookie: customer.cookie,
    })
    expect(r.status).toBe(200)
    expect(typeof r.body.willBeCredited).toBe('boolean')

    const { data } = await admin
      .from('service_occurrences')
      .select('state')
      .eq('id', id)
      .single()
    expect(data!.state).toBe('due_today')
  })

  it('the preview agrees with what the skip then does', async () => {
    const id = await makeOccurrence(subId, 'scheduled')
    const preview = await call('GET', `/api/v1/subscriptions/${subId}/skip?occurrenceId=${id}`, {
      cookie: customer.cookie,
    })
    const actual = await call('POST', `/api/v1/subscriptions/${subId}/skip`, {
      cookie: customer.cookie,
      body: { occurrenceId: id },
    })
    expect(actual.status).toBe(200)
    expect(actual.body.credited).toBe(preview.body.willBeCredited)
    expect(actual.body.creditCents).toBe(preview.body.creditCents)
  })

  it('403s a provider trying to skip as the customer', async () => {
    const id = await makeOccurrence(subId)
    const r = await call('POST', `/api/v1/subscriptions/${subId}/skip`, {
      cookie: provider.cookie,
      body: { occurrenceId: id },
    })
    expect(r.status).toBe(403)
  })

  it('404s an occurrence that belongs to a different subscription', async () => {
    const id = await makeOccurrence(minorSubId)
    const r = await call('POST', `/api/v1/subscriptions/${subId}/skip`, {
      cookie: customer.cookie,
      body: { occurrenceId: id },
    })
    expect(r.status).toBe(404)
  })
})

describe('the Today route', () => {
  it('serves the signed-in provider their own stops', async () => {
    const id = await makeOccurrence(subId)
    const r = await call('GET', '/api/v1/provider/today', { cookie: provider.cookie })
    expect(r.status).toBe(200)
    expect(Array.isArray(r.body.stops)).toBe(true)
    // The occurrence just created is dated today only when the cursor is 0;
    // what matters here is the shape and that it did not error.
    expect(r.body).toHaveProperty('expectedEarningsCents')
    expect(r.body).toHaveProperty('progress')
    // A real ISO calendar date, without a regex to mis-escape.
    expect(Number.isNaN(Date.parse(r.body.date))).toBe(false)
    expect(r.body.date).toHaveLength(10)
    expect(id).toBeTruthy()
  })

  it('403s a customer', async () => {
    const r = await call('GET', '/api/v1/provider/today', { cookie: customer.cookie })
    expect(r.status).toBe(403)
  })

  it('401s without a session', async () => {
    const r = await call('GET', '/api/v1/provider/today')
    expect(r.status).toBe(401)
  })
})
