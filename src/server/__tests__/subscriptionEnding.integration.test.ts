/**
 * Pausing and cancelling, against the live database and a stubbed processor.
 *
 * Money claims, asserted as outcomes:
 *
 *   - cancelling refunds the credit that has nowhere left to go;
 *   - pausing refunds nothing, because a pause may resume and spend it;
 *   - pausing is not a back door around the notice rule;
 *   - completed work stays completed and stays paid for;
 *   - a cancelled subscription cannot be revived;
 *   - a customer cannot end somebody else's subscription;
 *   - the ledger still sums to zero afterwards.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'
import {
  cancelSubscription,
  pauseSubscription,
  previewEnding,
  resumeSubscription,
} from '@/server/subscriptionService'
import { setCharger, StubCharger } from '@/server/charger'
import { settleSubscription } from '@/server/settlementService'
import { standingCreditCents, type LedgerEntry } from '@/domain/ledger'

const url = process.env['NEXT_PUBLIC_SUPABASE_URL']!
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY']!
const admin = createClient<Database>(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const stamp = Date.now()
const PRICE = 300

let providerId = ''
let customerId = ''
let otherCustomerId = ''
let serviceId = ''
let charger: StubCharger

const madeSubs: string[] = []
const madeUsers: string[] = []

/** Cycle runs 1--28 September. "Today" is the 10th, mid-cycle. */
const CYCLE_START = '2026-09-01'
const CYCLE_END = '2026-09-28'
const NOW = new Date('2026-09-10T18:00:00Z')

async function makeUser(email: string): Promise<string> {
  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    password: `Test-${stamp}-Aa1!`,
    email_confirm: true,
  })
  if (error || !created.user) throw new Error(`createUser failed: ${error?.message}`)
  const { data: du } = await admin
    .from('users')
    .select('id')
    .eq('auth_user_id', created.user.id)
    .single()
  madeUsers.push(du!.id)
  return du!.id
}

let addressCursor = 0

async function makeSubscription(): Promise<string> {
  const { data: addr, error: addrErr } = await admin
    .from('customer_addresses')
    .insert({
      customer_user_id: customerId,
      line1: `${400 + addressCursor++} Ending Way`,
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
  madeSubs.push(data!.id)
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
      local_timezone: 'UTC',
      state,
      service_value_cents: PRICE,
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
    .select('kind, amount_cents, idempotency_key')
    .eq('subscription_id', subId)
  return data ?? []
}

const sum = (rows: Array<{ amount_cents: number }>) => rows.reduce((a, r) => a + r.amount_cents, 0)

/**
 * What the customer is still owed.
 *
 * Not the ledger sum: a credit is three entries that net to zero, so the
 * whole-ledger sum stays at zero whether or not a credit is outstanding.
 * The outstanding part is the credit and adjustment rows specifically.
 *
 * Uses the domain function rather than reimplementing it -- a hand-rolled
 * version here returned negative zero, which is not equal to zero.
 */
const standing = (rows: Array<{ kind: string; amount_cents: number }>) =>
  standingCreditCents(
    rows.map((r) => ({ kind: r.kind, amountCents: r.amount_cents, currency: 'USD' })) as LedgerEntry[],
  )

async function stateOf(subId: string): Promise<string> {
  const { data } = await admin.from('subscriptions').select('state').eq('id', subId).single()
  return data!.state
}

async function occState(id: string): Promise<string> {
  const { data } = await admin.from('service_occurrences').select('state').eq('id', id).single()
  return data!.state
}

/** A subscription with a charged cycle, so there is something to refund. */
async function chargedSubscription(): Promise<string> {
  const subId = await makeSubscription()
  // Wind the cycle back so settlement runs, then restore the window.
  await admin
    .from('subscriptions')
    .update({ current_cycle_start: '2026-08-04', current_cycle_end: '2026-08-31' })
    .eq('id', subId)
  await settleSubscription({ db: admin, subscriptionId: subId, now: new Date('2026-09-01T12:00:00Z') })
  await admin
    .from('subscriptions')
    .update({ current_cycle_start: CYCLE_START, current_cycle_end: CYCLE_END })
    .eq('id', subId)
  return subId
}

beforeAll(async () => {
  providerId = await makeUser(`end-provider-${stamp}@example.com`)
  customerId = await makeUser(`end-customer-${stamp}@example.com`)
  otherCustomerId = await makeUser(`end-other-${stamp}@example.com`)

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
      name: `Ending Test ${stamp}`,
      slug: `ending-test-${stamp}`,
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

  const { data: svc, error } = await admin
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
  if (error) throw new Error(`service insert failed: ${error.message}`)
  serviceId = svc!.id
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
    await admin.from('audit_log').delete().in('target_id', madeSubs)
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

describe('cancelling is self-service and immediate', () => {
  it('takes effect straight away', async () => {
    const subId = await makeSubscription()
    const r = await cancelSubscription({
      db: admin,
      subscriptionId: subId,
      actorUserId: customerId,
      now: NOW,
    })

    expect(r.ok).toBe(true)
    expect(await stateOf(subId)).toBe('canceled')
  })

  it('releases future visits and credits the ones with notice', async () => {
    const subId = await makeSubscription()
    const future = await addOccurrence(subId, '2026-09-15', 'scheduled')

    const r = await cancelSubscription({
      db: admin,
      subscriptionId: subId,
      actorUserId: customerId,
      now: NOW,
    })

    expect(r.ok).toBe(true)
    if (r.ok) expect(r.plan.released).toHaveLength(1)
    expect(await occState(future)).toBe('credited')
  })

  it('leaves completed work completed and paid for', async () => {
    const subId = await makeSubscription()
    const done = await addOccurrence(subId, '2026-09-03', 'completed')

    await cancelSubscription({
      db: admin,
      subscriptionId: subId,
      actorUserId: customerId,
      now: NOW,
    })

    expect(await occState(done)).toBe('completed')
  })

  it('does not credit a visit inside the notice window', async () => {
    const subId = await makeSubscription()
    const today = await addOccurrence(subId, '2026-09-10', 'due_today')

    const r = await cancelSubscription({
      db: admin,
      subscriptionId: subId,
      actorUserId: customerId,
      now: NOW,
    })

    if (r.ok) expect(r.plan.released[0]!.credit.credited).toBe(false)
    // Released but not credited: the visit will not happen and is still billed.
    expect(await occState(today)).toBe('canceled')
  })

  it('refuses to cancel somebody else subscription', async () => {
    const subId = await makeSubscription()
    const r = await cancelSubscription({
      db: admin,
      subscriptionId: subId,
      actorUserId: otherCustomerId,
      now: NOW,
    })

    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('NOT_YOUR_SUBSCRIPTION')
    expect(await stateOf(subId)).toBe('active')
  })

  it('cannot be cancelled twice', async () => {
    const subId = await makeSubscription()
    await cancelSubscription({ db: admin, subscriptionId: subId, actorUserId: customerId, now: NOW })
    const again = await cancelSubscription({
      db: admin,
      subscriptionId: subId,
      actorUserId: customerId,
      now: NOW,
    })
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.code).toBe('ILLEGAL_TRANSITION')
  })

  it('cannot be resumed afterwards', async () => {
    const subId = await makeSubscription()
    await cancelSubscription({ db: admin, subscriptionId: subId, actorUserId: customerId, now: NOW })
    const r = await resumeSubscription({
      db: admin,
      subscriptionId: subId,
      actorUserId: customerId,
    })
    expect(r.ok).toBe(false)
  })
})

describe('the refund on cancellation', () => {
  it('refunds credit that has nowhere left to go', async () => {
    const subId = await chargedSubscription()
    await addOccurrence(subId, '2026-09-15', 'scheduled')

    const r = await cancelSubscription({
      db: admin,
      subscriptionId: subId,
      actorUserId: customerId,
      now: NOW,
    })

    expect(r.ok).toBe(true)
    if (r.ok) {
      // One released visit: 300 service + 45 fee share.
      expect(r.refundedCents).toBe(345)
      expect(r.refundPending).toBe(false)
    }
    expect(charger.refunds).toHaveLength(1)
    expect(charger.refunds[0]!.amountCents).toBe(345)
  })

  it('leaves the ledger balanced after the refund', async () => {
    const subId = await chargedSubscription()
    await addOccurrence(subId, '2026-09-15', 'scheduled')
    await cancelSubscription({ db: admin, subscriptionId: subId, actorUserId: customerId, now: NOW })

    const rows = await ledgerFor(subId)
    expect(sum(rows)).toBe(0)
    // And nothing is left owed once the money has actually gone back.
    expect(standing(rows)).toBe(0)
  })

  it('refunds nothing when nothing is owed', async () => {
    const subId = await chargedSubscription()
    const r = await cancelSubscription({
      db: admin,
      subscriptionId: subId,
      actorUserId: customerId,
      now: NOW,
    })
    if (r.ok) expect(r.refundedCents).toBe(0)
    expect(charger.refunds).toHaveLength(0)
  })

  it('reports refundPending rather than pretending, when the refund fails', async () => {
    const subId = await chargedSubscription()
    await addOccurrence(subId, '2026-09-15', 'scheduled')
    charger.setRefundOutcome({ ok: false, processor: 'stub', message: 'processor down' })

    const r = await cancelSubscription({
      db: admin,
      subscriptionId: subId,
      actorUserId: customerId,
      now: NOW,
    })

    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.refundPending).toBe(true)
      expect(r.refundedCents).toBe(0)
    }
    // The credit is still outstanding, so the customer is still owed it --
    // and the ledger still balances, because a credit nets to zero on its own.
    const rows = await ledgerFor(subId)
    expect(standing(rows)).toBe(345)
    expect(sum(rows)).toBe(0)
  })

  it('carries an idempotency key so a retry cannot double-refund', async () => {
    const subId = await chargedSubscription()
    await addOccurrence(subId, '2026-09-15', 'scheduled')
    await cancelSubscription({ db: admin, subscriptionId: subId, actorUserId: customerId, now: NOW })
    expect(charger.refunds[0]!.idempotencyKey).toBe(`refund:${subId}`)
  })
})

describe('pausing', () => {
  it('stops the subscription without ending it', async () => {
    const subId = await makeSubscription()
    const r = await pauseSubscription({
      db: admin,
      subscriptionId: subId,
      actorUserId: customerId,
      now: NOW,
    })
    expect(r.ok).toBe(true)
    expect(await stateOf(subId)).toBe('paused')
  })

  it('refunds nothing, because a pause may resume', async () => {
    const subId = await chargedSubscription()
    await addOccurrence(subId, '2026-09-15', 'scheduled')

    const r = await pauseSubscription({
      db: admin,
      subscriptionId: subId,
      actorUserId: customerId,
      now: NOW,
    })

    expect(r.ok).toBe(true)
    if (r.ok) expect(r.refundedCents).toBe(0)
    expect(charger.refunds).toHaveLength(0)

    // The credit exists and is waiting to be spent on the next cycle.
    const rows = await ledgerFor(subId)
    expect(standing(rows)).toBe(345)
    expect(sum(rows)).toBe(0)
  })

  it('is not a back door around the notice rule', async () => {
    const subId = await makeSubscription()
    const today = await addOccurrence(subId, '2026-09-10', 'due_today')

    const r = await pauseSubscription({
      db: admin,
      subscriptionId: subId,
      actorUserId: customerId,
      now: NOW,
    })

    // Same answer a same-day skip would have given.
    if (r.ok) expect(r.plan.released[0]!.credit.credited).toBe(false)
    expect(await occState(today)).toBe('canceled')
  })

  it('resumes back to active', async () => {
    const subId = await makeSubscription()
    await pauseSubscription({ db: admin, subscriptionId: subId, actorUserId: customerId, now: NOW })
    const r = await resumeSubscription({
      db: admin,
      subscriptionId: subId,
      actorUserId: customerId,
    })
    expect(r.ok).toBe(true)
    expect(await stateOf(subId)).toBe('active')
  })

  it('refuses to resume somebody else subscription', async () => {
    const subId = await makeSubscription()
    await pauseSubscription({ db: admin, subscriptionId: subId, actorUserId: customerId, now: NOW })
    const r = await resumeSubscription({
      db: admin,
      subscriptionId: subId,
      actorUserId: otherCustomerId,
    })
    expect(r.ok).toBe(false)
  })
})

describe('the preview matches what happens', () => {
  it('predicts the cancellation refund', async () => {
    const subId = await chargedSubscription()
    await addOccurrence(subId, '2026-09-15', 'scheduled')

    const preview = await previewEnding({
      db: admin,
      subscriptionId: subId,
      actorUserId: customerId,
      now: NOW,
      ending: 'cancel',
    })
    expect(preview.ok).toBe(true)
    const predicted = preview.ok ? preview.plan.refundableCents : -1

    const actual = await cancelSubscription({
      db: admin,
      subscriptionId: subId,
      actorUserId: customerId,
      now: NOW,
    })

    expect(actual.ok).toBe(true)
    if (actual.ok) expect(actual.refundedCents).toBe(predicted)
  })

  it('says a pause refunds nothing', async () => {
    const subId = await chargedSubscription()
    await addOccurrence(subId, '2026-09-15', 'scheduled')

    const preview = await previewEnding({
      db: admin,
      subscriptionId: subId,
      actorUserId: customerId,
      now: NOW,
      ending: 'pause',
    })
    if (preview.ok) expect(preview.plan.refundableCents).toBe(0)
  })

  it('changes nothing', async () => {
    const subId = await makeSubscription()
    const future = await addOccurrence(subId, '2026-09-15', 'scheduled')

    await previewEnding({
      db: admin,
      subscriptionId: subId,
      actorUserId: customerId,
      now: NOW,
      ending: 'cancel',
    })

    expect(await stateOf(subId)).toBe('active')
    expect(await occState(future)).toBe('scheduled')
  })

  it('refuses to preview somebody else subscription', async () => {
    const subId = await makeSubscription()
    const r = await previewEnding({
      db: admin,
      subscriptionId: subId,
      actorUserId: otherCustomerId,
      now: NOW,
      ending: 'cancel',
    })
    expect(r.ok).toBe(false)
  })
})
