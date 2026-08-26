/**
 * The horizon and due-today jobs, against the live database.
 *
 * The claims worth testing here are the ones that only show up over time or
 * across a map:
 *
 *   - running twice does not duplicate a visit;
 *   - a subscription already topped up costs no writes;
 *   - a route becomes due on its own local Tuesday, not on UTC's;
 *   - a paused subscription stops accruing future work;
 *   - ending a subscription cancels future visits without owing credits,
 *     and does not touch a stop the provider is already standing at.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'
import {
  civilDateIn,
  extendHorizon,
  promoteDueToday,
  cancelFutureOccurrences,
} from '@/server/occurrenceJobs'
import { isoDate } from '@/domain/schedule'

const url = process.env['NEXT_PUBLIC_SUPABASE_URL']!
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY']!
const admin = createClient<Database>(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const stamp = Date.now()

let providerId = ''
let customerId = ''
let businessId = ''
let chicagoSubId = ''
let honoluluSubId = ''
let addressId = ''

const PRICE = 300

/**
 * 2026-09-01T07:00:00Z, chosen to sit between two local midnights.
 *
 * Chicago is UTC-5 in September, so 07:00Z is 02:00 on Tuesday the 1st --
 * the route is due. Honolulu is UTC-10 and has no DST, so the same instant
 * is 21:00 on Monday the 31st -- that route is not. Any code deciding
 * "today" from the UTC date gets one of the two wrong.
 *
 * The window is narrow: before 05:00Z it is still August in Chicago too,
 * and after 10:00Z it is September in Honolulu as well.
 */
const ACROSS_MIDNIGHT = new Date('2026-09-01T07:00:00Z')

async function makeUser(email: string): Promise<string> {
  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    password: `Test-${stamp}-Aa1!`,
    email_confirm: true,
  })
  if (error || !created?.user) throw new Error(`createUser failed: ${error?.message}`)
  const { data: du } = await admin
    .from('users')
    .select('id')
    .eq('auth_user_id', created.user.id)
    .single()
  return du!.id
}

/**
 * One business, several services. businesses has
 * ux_one_live_business_per_provider -- a provider runs one business -- so
 * the two time zones here are two services under it, which is also how a
 * real provider serving two neighbourhoods would be set up.
 */
async function makeService(timezone: string, slug: string): Promise<string> {
  const { data: cat } = await admin
    .from('service_catalog')
    .select('id')
    .eq('code', 'bin_curb_service')
    .single()

  const { data: svc, error } = await admin
    .from('provider_services')
    .insert({
      business_id: businessId,
      catalog_service_id: cat!.id,
      slug: `weekly-bins-${slug}`,
      public_name: `Weekly bins ${slug}`,
      description: 'A description long enough to satisfy the constraint.',
      price_cents: PRICE,
      price_unit: 'week',
      billing_cycle_weeks: 4,
      schedule_rule: {
        frequency: 'weekly',
        weekdays: ['tuesday'],
        timezone,
      },
      capacity_rule: { maxAddresses: 50 },
      state: 'active',
    })
    .select('id')
    .single()
  if (error) throw new Error(`service insert failed: ${error.message}`)
  return svc!.id
}

async function makeSubscription(serviceId: string): Promise<string> {
  const { data, error } = await admin
    .from('subscriptions')
    .insert({
      customer_user_id: customerId,
      provider_service_id: serviceId,
      service_address_id: addressId,
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
  return data!.id
}

async function occurrencesFor(subId: string) {
  const { data } = await admin
    .from('service_occurrences')
    .select('service_date, state, local_timezone')
    .eq('subscription_id', subId)
    .order('service_date')
  return data ?? []
}

beforeAll(async () => {
  providerId = await makeUser(`jobs-provider-${stamp}@example.com`)
  customerId = await makeUser(`jobs-customer-${stamp}@example.com`)

  await admin.from('provider_profiles').insert({
    user_id: providerId,
    date_of_birth: '1990-01-01',
    display_first_name: 'Alex',
    guardian_state: 'not_required',
  })

  const { data: addr } = await admin
    .from('customer_addresses')
    .insert({
      customer_user_id: customerId,
      line1: '100 Inside St',
      city: 'Austin',
      region: 'TX',
      postal_code: '78701',
      country_code: 'US',
    })
    .select('id')
    .single()
  addressId = addr!.id

  const { data: biz, error: bizErr } = await admin
    .from('businesses')
    .insert({
      provider_user_id: providerId,
      name: `Jobs Test ${stamp}`,
      slug: `jobs-test-${stamp}`,
      state: 'published',
      published_at: new Date().toISOString(),
      public_area_label: 'Downtown',
    })
    .select('id')
    .single()
  if (bizErr) throw new Error(`business insert failed: ${bizErr.message}`)
  businessId = biz!.id

  chicagoSubId = await makeSubscription(await makeService('America/Chicago', 'chi'))
  honoluluSubId = await makeSubscription(await makeService('Pacific/Honolulu', 'hnl'))
})

afterAll(async () => {
  const subIds = [chicagoSubId, honoluluSubId].filter(Boolean)
  if (subIds.length) {
    await admin.from('service_occurrences').delete().in('subscription_id', subIds)
    await admin.from('ledger_entries').delete().in('subscription_id', subIds)
    await admin.from('subscriptions').delete().in('id', subIds)
  }
  const ids = [customerId, providerId].filter(Boolean)
  await admin.from('customer_addresses').delete().in('customer_user_id', ids)
  for (const id of ids) {
    const { data: u } = await admin.from('users').select('auth_user_id').eq('id', id).maybeSingle()
    await admin.from('audit_log').delete().eq('actor_user_id', id)
    await admin.from('users').delete().eq('id', id)
    if (u?.auth_user_id) await admin.auth.admin.deleteUser(u.auth_user_id).catch(() => {})
  }
})

describe('civilDateIn', () => {
  it('reads the same instant as two different calendar days', () => {
    expect(isoDate(civilDateIn('America/Chicago', ACROSS_MIDNIGHT))).toBe('2026-09-01')
    expect(isoDate(civilDateIn('Pacific/Honolulu', ACROSS_MIDNIGHT))).toBe('2026-08-31')
  })

  it('is not fooled by a DST transition', () => {
    // US DST ends 2026-11-01. 06:30Z is 01:30 local on both sides of it.
    const during = new Date('2026-11-01T06:30:00Z')
    expect(isoDate(civilDateIn('America/Chicago', during))).toBe('2026-11-01')
  })
})

describe('extending the horizon', () => {
  it('creates occurrences out to the horizon', async () => {
    const r = await extendHorizon({ db: admin, now: ACROSS_MIDNIGHT, horizonWeeks: 4 })
    expect(r.failures).toEqual([])

    const occs = await occurrencesFor(chicagoSubId)
    // Weekly on Tuesdays over four weeks: four or five, depending on where
    // the window lands relative to the first Tuesday.
    expect(occs.length).toBeGreaterThanOrEqual(4)
    expect(occs.every((o) => o.state === 'scheduled')).toBe(true)
  })

  it('stamps each occurrence with the service local zone', async () => {
    const chi = await occurrencesFor(chicagoSubId)
    const hnl = await occurrencesFor(honoluluSubId)
    expect(chi.every((o) => o.local_timezone === 'America/Chicago')).toBe(true)
    expect(hnl.every((o) => o.local_timezone === 'Pacific/Honolulu')).toBe(true)
  })

  it('is idempotent -- a second run creates nothing new', async () => {
    const before = (await occurrencesFor(chicagoSubId)).length

    const second = await extendHorizon({ db: admin, now: ACROSS_MIDNIGHT, horizonWeeks: 4 })
    expect(second.failures).toEqual([])
    expect(second.occurrencesCreated).toBe(0)

    expect((await occurrencesFor(chicagoSubId)).length).toBe(before)
  })

  it('never writes two visits for the same day', async () => {
    const occs = await occurrencesFor(chicagoSubId)
    const dates = occs.map((o) => o.service_date)
    expect(new Set(dates).size).toBe(dates.length)
  })

  it('extends further when the horizon grows', async () => {
    const before = (await occurrencesFor(chicagoSubId)).length
    const r = await extendHorizon({ db: admin, now: ACROSS_MIDNIGHT, horizonWeeks: 8 })
    expect(r.failures).toEqual([])
    expect((await occurrencesFor(chicagoSubId)).length).toBeGreaterThan(before)
  })

  it('skips a paused subscription', async () => {
    await admin.from('subscriptions').update({ state: 'paused' }).eq('id', honoluluSubId)
    const before = (await occurrencesFor(honoluluSubId)).length

    const r = await extendHorizon({ db: admin, now: ACROSS_MIDNIGHT, horizonWeeks: 12 })
    expect(r.failures).toEqual([])
    expect((await occurrencesFor(honoluluSubId)).length).toBe(before)

    await admin.from('subscriptions').update({ state: 'active' }).eq('id', honoluluSubId)
  })
})

describe('promoting to due_today respects local midnight', () => {
  it('makes the Chicago route due but leaves Honolulu alone', async () => {
    // Both subscriptions have a Tuesday 2026-09-01 occurrence. At the test
    // instant it is the 1st in Chicago and still the 31st in Honolulu.
    await promoteDueToday({ db: admin, now: ACROSS_MIDNIGHT })

    const chi = await occurrencesFor(chicagoSubId)
    const hnl = await occurrencesFor(honoluluSubId)

    const chiFirst = chi.find((o) => o.service_date === '2026-09-01')
    const hnlFirst = hnl.find((o) => o.service_date === '2026-09-01')

    expect(chiFirst?.state).toBe('due_today')
    expect(hnlFirst?.state).toBe('scheduled')
  })

  it('leaves later occurrences scheduled', async () => {
    const chi = await occurrencesFor(chicagoSubId)
    const later = chi.filter((o) => o.service_date > '2026-09-01')
    expect(later.length).toBeGreaterThan(0)
    expect(later.every((o) => o.state === 'scheduled')).toBe(true)
  })

  it('promotes Honolulu once its own midnight passes', async () => {
    // Six hours later it is the 1st in Honolulu too.
    await promoteDueToday({ db: admin, now: new Date('2026-09-01T14:00:00Z') })

    const hnl = await occurrencesFor(honoluluSubId)
    expect(hnl.find((o) => o.service_date === '2026-09-01')?.state).toBe('due_today')
  })

  it('picks up a stop the job missed on an earlier day', async () => {
    // A run a week late should surface the older stop rather than strand it.
    await promoteDueToday({ db: admin, now: new Date('2026-09-09T14:00:00Z') })
    const chi = await occurrencesFor(chicagoSubId)
    const past = chi.filter((o) => o.service_date <= '2026-09-08')
    expect(past.every((o) => o.state !== 'scheduled')).toBe(true)
  })
})

describe('cancelling a subscription', () => {
  it('cancels future work without crediting anybody', async () => {
    const before = await occurrencesFor(chicagoSubId)
    const scheduledBefore = before.filter((o) => o.state === 'scheduled').length
    expect(scheduledBefore).toBeGreaterThan(0)

    const r = await cancelFutureOccurrences({ db: admin, subscriptionId: chicagoSubId })
    expect(r.canceled).toBe(scheduledBefore)

    const after = await occurrencesFor(chicagoSubId)
    expect(after.filter((o) => o.state === 'scheduled')).toHaveLength(0)

    const { data: ledger } = await admin
      .from('ledger_entries')
      .select('id')
      .eq('subscription_id', chicagoSubId)
    expect(ledger ?? []).toHaveLength(0)
  })

  it('does not touch a stop the provider may already be at', async () => {
    const after = await occurrencesFor(chicagoSubId)
    const due = after.filter((o) => o.state === 'due_today')
    // due_today rows survived the cancel: they are the provider's to
    // complete or skip, and deciding for them would move money.
    expect(due.length).toBeGreaterThan(0)
  })
})
