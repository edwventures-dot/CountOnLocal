/**
 * Cycle settlement, against the live database and a stubbed processor.
 *
 * The claims here are about money, so they are asserted as outcomes -- what
 * each party ends up holding -- rather than as row shapes. The previous
 * credit bug passed a shape assertion happily while the provider kept money
 * for a visit they never made.
 *
 *   - a cycle charges once, and a re-run does not charge again;
 *   - a standing credit is consumed exactly once;
 *   - a declined card takes the subscription out of active and writes
 *     nothing to the ledger;
 *   - delivered work settles, and work nobody resolved does not;
 *   - the subscription's ledger sums to zero throughout.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'
import { settleSubscription } from '@/server/settlementService'
import { setCharger, StubCharger } from '@/server/charger'
import { skipOccurrence } from '@/server/occurrenceService'
import { parseServiceDate } from '@/server/occurrenceService'
import { isoDate, addDays } from '@/domain/schedule'

const url = process.env['NEXT_PUBLIC_SUPABASE_URL']!
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY']!
const admin = createClient<Database>(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const stamp = Date.now()
const PRICE = 300

let providerId = ''
let customerId = ''
let serviceId = ''
let addressId = ''
let charger: StubCharger

/** Cycle 1 runs 1--28 September; settlement happens on the 29th. */
const CYCLE_START = '2026-09-01'
const CYCLE_END = '2026-09-28'
const AFTER_CYCLE = new Date('2026-09-29T15:00:00Z') // afternoon in Chicago

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

let addressCursor = 0

/**
 * A fresh subscription with its first cycle already open.
 *
 * Each one gets its own address. ux_one_live_subscription is unique on
 * (customer, service, address) across the live states -- the index that
 * stops a second Subscribe click producing a second bill -- so reusing one
 * address would collide after the first.
 */
async function makeSubscription(): Promise<string> {
  const { data: addr, error: addrErr } = await admin
    .from('customer_addresses')
    .insert({
      customer_user_id: customerId,
      line1: `${200 + addressCursor++} Settle Ave`,
      city: 'Austin',
      region: 'TX',
      postal_code: '78701',
      country_code: 'US',
    })
    .select('id')
    .single()
  if (addrErr) throw new Error(`address insert failed: ${addrErr.message}`)

  const { data, error } = await admin
    .from('subscriptions')
    .insert({
      customer_user_id: customerId,
      provider_service_id: serviceId,
      service_address_id: addr!.id,
      state: 'active',
      provider_price_cents: PRICE,
      price_unit: 'week',
      platform_fee_bps: 1500,
      platform_fee_min_cents: 100,
      billing_cycle_weeks: 4,
      current_cycle_start: CYCLE_START,
      current_cycle_end: CYCLE_END,
      stripe_customer_id: `cus_test_${stamp}`,
      stripe_payment_method_id: `pm_test_${stamp}`,
    })
    .select('id')
    .single()
  if (error) throw new Error(`subscription insert failed: ${error.message}`)
  return data!.id
}

async function addOccurrence(
  subId: string,
  dateIso: string,
  state: NonNullable<Database['public']['Tables']['service_occurrences']['Insert']['state']>,
): Promise<string> {
  const { data, error } = await admin
    .from('service_occurrences')
    .insert({
      subscription_id: subId,
      service_date: dateIso,
      local_timezone: 'America/Chicago',
      state,
      service_value_cents: PRICE,
      // completed_has_timestamp: the table refuses a completed row without
      // one, which is right -- "done" with no time is not a record of
      // anything.
      ...(state === 'completed' ? { completed_at: `${dateIso}T18:00:00Z` } : {}),
    })
    .select('id')
    .single()
  if (error) throw new Error(`occurrence insert failed: ${error.message}`)
  return data!.id
}

async function ledgerFor(subId: string) {
  const { data } = await admin
    .from('ledger_entries')
    .select('kind, amount_cents, idempotency_key, external_id')
    .eq('subscription_id', subId)
  return data ?? []
}

const sum = (rows: Array<{ amount_cents: number }>) => rows.reduce((a, r) => a + r.amount_cents, 0)
const byKind = (rows: Array<{ kind: string; amount_cents: number }>, kind: string) =>
  rows.filter((r) => r.kind === kind).reduce((a, r) => a + r.amount_cents, 0)

async function subscriptionRow(subId: string) {
  const { data } = await admin
    .from('subscriptions')
    .select('state, current_cycle_start, current_cycle_end')
    .eq('id', subId)
    .single()
  return data!
}

const madeSubs: string[] = []
async function freshSubscription(): Promise<string> {
  const id = await makeSubscription()
  madeSubs.push(id)
  return id
}

beforeAll(async () => {
  providerId = await makeUser(`settle-provider-${stamp}@example.com`)
  customerId = await makeUser(`settle-customer-${stamp}@example.com`)

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
      name: `Settle Test ${stamp}`,
      slug: `settle-test-${stamp}`,
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
      },
      capacity_rule: { maxAddresses: 500 },
      state: 'active',
    })
    .select('id')
    .single()
  if (svcErr) throw new Error(`service insert failed: ${svcErr.message}`)
  serviceId = svc!.id

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
})

beforeEach(() => {
  charger = new StubCharger()
  setCharger(charger)
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
  const ids = [customerId, providerId].filter(Boolean)
  await admin.from('customer_addresses').delete().in('customer_user_id', ids)
  for (const id of ids) {
    const { data: u } = await admin.from('users').select('auth_user_id').eq('id', id).maybeSingle()
    await admin.from('audit_log').delete().eq('actor_user_id', id)
    await admin.from('users').delete().eq('id', id)
    if (u?.auth_user_id) await admin.auth.admin.deleteUser(u.auth_user_id).catch(() => {})
  }
  await admin.from('audit_log').delete().in('target_id', madeSubs)
})

describe('a cycle that is not over yet', () => {
  it('does nothing before the end date', async () => {
    const subId = await freshSubscription()
    const r = await settleSubscription({
      db: admin,
      subscriptionId: subId,
      now: new Date('2026-09-20T15:00:00Z'),
    })

    expect(r.ok && r.status).toBe('not_due')
    expect(charger.requests).toHaveLength(0)
    expect(await ledgerFor(subId)).toHaveLength(0)
  })

  it('is still not due on the last day of the cycle', async () => {
    const subId = await freshSubscription()
    const r = await settleSubscription({
      db: admin,
      subscriptionId: subId,
      now: new Date('2026-09-28T15:00:00Z'),
    })
    expect(r.ok && r.status).toBe('not_due')
  })
})

describe('settling a clean cycle', () => {
  it('charges the full cycle once', async () => {
    const subId = await freshSubscription()
    await addOccurrence(subId, '2026-09-01', 'completed')
    await addOccurrence(subId, '2026-09-08', 'completed')

    const r = await settleSubscription({ db: admin, subscriptionId: subId, now: AFTER_CYCLE })

    expect(r.ok).toBe(true)
    expect(charger.requests).toHaveLength(1)
    expect(charger.requests[0]!.amountCents).toBe(1380)
  })

  it('writes a balanced charge set', async () => {
    const subId = await freshSubscription()
    await settleSubscription({ db: admin, subscriptionId: subId, now: AFTER_CYCLE })

    const rows = await ledgerFor(subId)
    expect(sum(rows)).toBe(0)
    expect(byKind(rows, 'customer_charge')).toBe(1380)
    expect(byKind(rows, 'provider_earning')).toBe(-1200)
    expect(byKind(rows, 'platform_fee')).toBe(-180)
  })

  it('records the processor reference on the charge', async () => {
    const subId = await freshSubscription()
    await settleSubscription({ db: admin, subscriptionId: subId, now: AFTER_CYCLE })
    const rows = await ledgerFor(subId)
    expect(rows.find((r) => r.kind === 'customer_charge')?.external_id).toBeTruthy()
  })

  it('settles delivered work and advances the cycle window', async () => {
    const subId = await freshSubscription()
    const a = await addOccurrence(subId, '2026-09-01', 'completed')
    await settleSubscription({ db: admin, subscriptionId: subId, now: AFTER_CYCLE })

    const { data: occ } = await admin
      .from('service_occurrences')
      .select('state')
      .eq('id', a)
      .single()
    expect(occ!.state).toBe('settled')

    const sub = await subscriptionRow(subId)
    expect(sub.current_cycle_start).toBe('2026-09-29')
    expect(sub.current_cycle_end).toBe('2026-10-26')
  })

  it('does not settle work nobody resolved', async () => {
    const subId = await freshSubscription()
    const stale = await addOccurrence(subId, '2026-09-15', 'due_today')

    const r = await settleSubscription({ db: admin, subscriptionId: subId, now: AFTER_CYCLE })
    expect(r.ok && r.status === 'settled' && r.plan.unresolved).toHaveLength(1)

    const { data: occ } = await admin
      .from('service_occurrences')
      .select('state')
      .eq('id', stale)
      .single()
    // Still due_today: not paid for, not credited, waiting on a human.
    expect(occ!.state).toBe('due_today')
  })
})

describe('a re-run cannot charge the card twice', () => {
  it('sends one request per cycle even when run again', async () => {
    const subId = await freshSubscription()
    await settleSubscription({ db: admin, subscriptionId: subId, now: AFTER_CYCLE })

    const key = charger.requests[0]!.idempotencyKey
    expect(charger.countFor(key)).toBe(1)

    // Second run: the window has advanced, so the same cycle is no longer due.
    const again = await settleSubscription({ db: admin, subscriptionId: subId, now: AFTER_CYCLE })
    expect(again.ok && again.status).toBe('not_due')
    expect(charger.countFor(key)).toBe(1)
  })

  it('refuses a duplicate ledger row if the same cycle is forced again', async () => {
    const subId = await freshSubscription()
    await settleSubscription({ db: admin, subscriptionId: subId, now: AFTER_CYCLE })
    const before = await ledgerFor(subId)

    // Wind the window back, as a crashed run between charge and advance
    // would leave it, and settle again.
    await admin
      .from('subscriptions')
      .update({ current_cycle_start: CYCLE_START, current_cycle_end: CYCLE_END })
      .eq('id', subId)

    await settleSubscription({ db: admin, subscriptionId: subId, now: AFTER_CYCLE })

    const after = await ledgerFor(subId)
    // The unique idempotency key refused the second charge set.
    expect(after.length).toBe(before.length)
    expect(sum(after)).toBe(0)
  })
})

describe('standing credit is consumed exactly once', () => {
  it('reduces the charge by the credit and leaves nothing standing', async () => {
    const subId = await freshSubscription()

    // A visit the provider skipped, credited at 300 + 45 fee share.
    const skipped = await addOccurrence(subId, '2026-09-08', 'due_today')
    const skip = await skipOccurrence({
      db: admin,
      occurrenceId: skipped,
      actor: 'provider',
      actorUserId: providerId,
      today: parseServiceDate('2026-09-08'),
    })
    expect(skip.ok).toBe(true)

    const r = await settleSubscription({ db: admin, subscriptionId: subId, now: AFTER_CYCLE })
    expect(r.ok).toBe(true)
    if (r.ok && r.status === 'settled') {
      expect(r.plan.creditAppliedCents).toBe(345)
      expect(r.plan.amountToChargeCents).toBe(1380 - 345)
    }

    expect(charger.requests[0]!.amountCents).toBe(1035)
  })

  it('leaves the whole subscription balanced and each party correct', async () => {
    const subId = await freshSubscription()

    const skipped = await addOccurrence(subId, '2026-09-08', 'due_today')
    await skipOccurrence({
      db: admin,
      occurrenceId: skipped,
      actor: 'provider',
      actorUserId: providerId,
      today: parseServiceDate('2026-09-08'),
    })
    await settleSubscription({ db: admin, subscriptionId: subId, now: AFTER_CYCLE })

    const rows = await ledgerFor(subId)
    expect(sum(rows)).toBe(0)

    // Provider: credited 1200 for the new cycle, less 300 for the visit
    // they did not make.
    expect(-byKind(rows, 'provider_earning')).toBe(900)
    // Platform: 180 for the cycle, less its 45 on the missing visit.
    expect(-byKind(rows, 'platform_fee')).toBe(135)
  })
})

describe('a declined card', () => {
  it('takes the subscription out of active and writes no ledger rows', async () => {
    const subId = await freshSubscription()
    charger.setOutcome({
      ok: false,
      code: 'declined',
      processor: 'stub',
      message: 'Your card was declined.',
    })

    const r = await settleSubscription({ db: admin, subscriptionId: subId, now: AFTER_CYCLE })

    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('CARD_DECLINED')

    expect(await ledgerFor(subId)).toHaveLength(0)
    expect((await subscriptionRow(subId)).state).toBe('payment_failed')
  })

  it('does not advance the cycle window on a decline', async () => {
    const subId = await freshSubscription()
    charger.setOutcome({
      ok: false,
      code: 'declined',
      processor: 'stub',
      message: 'declined',
    })
    await settleSubscription({ db: admin, subscriptionId: subId, now: AFTER_CYCLE })

    const sub = await subscriptionRow(subId)
    expect(sub.current_cycle_end).toBe(CYCLE_END)
  })

  it('does not settle occurrences when the charge failed', async () => {
    const subId = await freshSubscription()
    const done = await addOccurrence(subId, '2026-09-01', 'completed')
    charger.setOutcome({ ok: false, code: 'declined', processor: 'stub', message: 'no' })

    await settleSubscription({ db: admin, subscriptionId: subId, now: AFTER_CYCLE })

    const { data: occ } = await admin
      .from('service_occurrences')
      .select('state')
      .eq('id', done)
      .single()
    expect(occ!.state).toBe('completed')
  })

  it('is retryable after a processor error, leaving state untouched', async () => {
    const subId = await freshSubscription()
    charger.setOutcome({ ok: false, code: 'error', processor: 'stub', message: 'timeout' })

    const r = await settleSubscription({ db: admin, subscriptionId: subId, now: AFTER_CYCLE })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('PROCESSOR_ERROR')

    // Still active -- a timeout is not the customer's fault.
    expect((await subscriptionRow(subId)).state).toBe('active')

    // And it works on the retry.
    charger.setOutcome({ ok: true, processor: 'stub', externalId: 'pi_retry' })
    const retry = await settleSubscription({ db: admin, subscriptionId: subId, now: AFTER_CYCLE })
    expect(retry.ok).toBe(true)
  })
})

describe('subscriptions that should be left alone', () => {
  it('skips a paused subscription', async () => {
    const subId = await freshSubscription()
    await admin.from('subscriptions').update({ state: 'paused' }).eq('id', subId)

    const r = await settleSubscription({ db: admin, subscriptionId: subId, now: AFTER_CYCLE })
    expect(r.ok && r.status).toBe('nothing_to_do')
    expect(charger.requests).toHaveLength(0)
  })

  it('does nothing without a cycle window', async () => {
    const subId = await freshSubscription()
    await admin
      .from('subscriptions')
      .update({ current_cycle_start: null, current_cycle_end: null })
      .eq('id', subId)

    const r = await settleSubscription({ db: admin, subscriptionId: subId, now: AFTER_CYCLE })
    expect(r.ok && r.status).toBe('nothing_to_do')
  })
})

describe('a cycle fully covered by credit', () => {
  it('charges nothing but still writes a balanced set', async () => {
    const subId = await freshSubscription()

    // Skip four visits: 4 x (300 + 45) = 1380, exactly one cycle.
    for (const day of ['2026-09-01', '2026-09-08', '2026-09-15', '2026-09-22']) {
      const id = await addOccurrence(subId, day, 'due_today')
      await skipOccurrence({
        db: admin,
        occurrenceId: id,
        actor: 'provider',
        actorUserId: providerId,
        today: parseServiceDate(day),
      })
    }

    const r = await settleSubscription({ db: admin, subscriptionId: subId, now: AFTER_CYCLE })
    expect(r.ok).toBe(true)
    if (r.ok && r.status === 'settled') {
      expect(r.plan.amountToChargeCents).toBe(0)
    }

    // The processor is never called for a zero charge.
    expect(charger.requests).toHaveLength(0)

    const rows = await ledgerFor(subId)
    expect(sum(rows)).toBe(0)
  })
})
