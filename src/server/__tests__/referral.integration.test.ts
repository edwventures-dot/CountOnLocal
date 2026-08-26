/**
 * Referral rewards, against the live database and a stubbed processor.
 *
 * The claims are about money, so they are asserted as outcomes -- what each
 * party ends up holding -- rather than as row shapes. That distinction is
 * not academic here: the credit bug in step 5 passed every shape assertion
 * while leaving a provider paid for work they never did.
 *
 * The one that matters most:
 *
 *   - the provider is owed exactly their listed price, referral or not.
 *
 * Everything else is a way of getting at that from a different angle.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'
import { settleSubscription } from '@/server/settlementService'
import { attachReferral, runReferralRewards } from '@/server/referralService'
import { setCharger, StubCharger } from '@/server/charger'
import { referralCodeFrom } from '@/domain/density'

const url = process.env['NEXT_PUBLIC_SUPABASE_URL']!
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY']!
const admin = createClient<Database>(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const stamp = Date.now()
const PRICE = 300
/** 4 weekly visits at $3 = $12.00 subtotal, 15% fee = $1.80. */
const SUBTOTAL = 1200
const FEE = 180

const CYCLE_START = '2026-09-01'
const CYCLE_END = '2026-09-28'
const AFTER_CYCLE = new Date('2026-09-29T15:00:00Z')

let referrerId = ''
let providerId = ''
let customerId = ''
let serviceId = ''
let code = ''

let charger: StubCharger
let addressCursor = 0
const madeSubs: string[] = []
const madeReferrals: string[] = []

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

async function freshSubscription(): Promise<string> {
  const { data: addr, error: addrErr } = await admin
    .from('customer_addresses')
    .insert({
      customer_user_id: customerId,
      line1: `${400 + addressCursor++} Referral Row`,
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
      stripe_customer_id: `cus_ref_${stamp}`,
      stripe_payment_method_id: `pm_ref_${stamp}`,
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
  state: 'scheduled' | 'completed',
): Promise<void> {
  const { error } = await admin.from('service_occurrences').insert({
    subscription_id: subId,
    service_date: dateIso,
    local_timezone: 'America/Chicago',
    state,
    service_value_cents: PRICE,
    ...(state === 'completed' ? { completed_at: `${dateIso}T18:00:00Z` } : {}),
  })
  if (error) throw new Error(`occurrence insert failed: ${error.message}`)
}

/** Four delivered visits, so the closing cycle is fully resolved. */
async function deliverCycle(subId: string): Promise<void> {
  for (const d of ['2026-09-01', '2026-09-08', '2026-09-15', '2026-09-22']) {
    await addOccurrence(subId, d, 'completed')
  }
}

async function attach(subId: string): Promise<string> {
  const r = await attachReferral({ db: admin, subscriptionId: subId, customerUserId: customerId, code })
  if (!r.applied) throw new Error(`attach failed: ${r.reason}`)
  madeReferrals.push(r.referralId)
  return r.referralId
}

async function ledgerFor(subId: string) {
  const { data } = await admin
    .from('ledger_entries')
    .select('kind, amount_cents')
    .eq('subscription_id', subId)
  return data ?? []
}

/**
 * The bonus rows for one referral, found by its idempotency key.
 *
 * Keyed rather than summed over the provider, because runReferralRewards is
 * a job: it processes every eligible referral in the database, including
 * ones other tests in this file left behind. A running total would make
 * these assertions depend on test order, which is exactly the kind of test
 * that passes while the thing it claims to check is broken.
 */
async function bonusRowsFor(referralId: string) {
  const { data } = await admin
    .from('ledger_entries')
    .select('kind, amount_cents, provider_user_id, subscription_id')
    .eq('idempotency_key', `referral_bonus:${referralId}`)
  return data ?? []
}

const byKind = (rows: Array<{ kind: string; amount_cents: number }>, kind: string) =>
  rows.filter((r) => r.kind === kind).reduce((a, r) => a + r.amount_cents, 0)
const sum = (rows: Array<{ amount_cents: number }>) => rows.reduce((a, r) => a + r.amount_cents, 0)

async function referralRow(id: string) {
  const { data } = await admin
    .from('referrals')
    .select('state, discount_applied_cents, qualified_at, paid_at, void_reason')
    .eq('id', id)
    .single()
  return data!
}

beforeAll(async () => {
  referrerId = await makeUser(`ref-referrer-${stamp}@example.com`)
  providerId = await makeUser(`ref-provider-${stamp}@example.com`)
  customerId = await makeUser(`ref-customer-${stamp}@example.com`)

  for (const [id, name] of [
    [referrerId, 'Robin'],
    [providerId, 'Alex'],
  ] as const) {
    await admin.from('provider_profiles').insert({
      user_id: id,
      date_of_birth: '1990-01-01',
      display_first_name: name,
      guardian_state: 'not_required',
    })
  }

  const { data: biz } = await admin
    .from('businesses')
    .insert({
      provider_user_id: providerId,
      name: `Referral Test ${stamp}`,
      slug: `referral-test-${stamp}`,
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
      schedule_rule: { frequency: 'weekly', weekdays: ['tuesday'], timezone: 'America/Chicago' },
      capacity_rule: { maxAddresses: 500 },
      state: 'active',
    })
    .select('id')
    .single()
  if (svcErr) throw new Error(`service insert failed: ${svcErr.message}`)
  serviceId = svc!.id

  // The referring provider is a different person from the one being
  // subscribed to, which is the ordinary case: a neighbour hands out a code
  // for the service they already use.
  code = referralCodeFrom(Uint8Array.from({ length: 8 }, (_, i) => (stamp + i * 7) % 251))
  const { error: codeErr } = await admin
    .from('referral_codes')
    .insert({ code, provider_user_id: referrerId })
  if (codeErr) throw new Error(`code insert failed: ${codeErr.message}`)
})

beforeEach(() => {
  charger = new StubCharger()
  setCharger(charger)
})

afterAll(async () => {
  if (madeReferrals.length) {
    await admin.from('audit_log').delete().in('target_id', madeReferrals)
    await admin.from('referrals').delete().in('id', madeReferrals)
  }
  if (madeSubs.length) {
    await admin.from('ledger_entries').delete().in('subscription_id', madeSubs)
    await admin.from('service_occurrences').delete().in('subscription_id', madeSubs)
    await admin.from('audit_log').delete().in('target_id', madeSubs)
    await admin.from('subscriptions').delete().in('id', madeSubs)
  }
  const ids = [customerId, providerId, referrerId].filter(Boolean)
  await admin.from('ledger_entries').delete().in('provider_user_id', ids)
  await admin.from('customer_addresses').delete().in('customer_user_id', ids)
  await admin.from('referral_codes').delete().eq('code', code)
  for (const id of ids) {
    const { data: u } = await admin.from('users').select('auth_user_id').eq('id', id).maybeSingle()
    await admin.from('audit_log').delete().eq('actor_user_id', id)
    await admin.from('users').delete().eq('id', id)
    if (u?.auth_user_id) await admin.auth.admin.deleteUser(u.auth_user_id).catch(() => {})
  }
})

describe('attaching a code', () => {
  it('records a pending referral', async () => {
    const subId = await freshSubscription()
    const id = await attach(subId)
    expect((await referralRow(id)).state).toBe('pending')
  })

  it('accepts a code typed in lower case with spaces around it', async () => {
    // It gets read aloud across a fence and typed off a flyer.
    const subId = await freshSubscription()
    const r = await attachReferral({
      db: admin,
      subscriptionId: subId,
      customerUserId: customerId,
      code: `  ${code.toLowerCase()} `,
    })
    expect(r.applied).toBe(true)
    if (r.applied) madeReferrals.push(r.referralId)
  })

  it('refuses a code nobody owns', async () => {
    const subId = await freshSubscription()
    const r = await attachReferral({
      db: admin,
      subscriptionId: subId,
      customerUserId: customerId,
      code: 'ZZZZZZZZ',
    })
    expect(r).toEqual({ applied: false, reason: 'UNKNOWN_CODE' })
  })

  it('refuses a second code on the same subscription', async () => {
    const subId = await freshSubscription()
    await attach(subId)
    const again = await attachReferral({ db: admin, subscriptionId: subId, customerUserId: customerId, code })
    expect(again).toEqual({ applied: false, reason: 'ALREADY_REFERRED' })
  })

  it('refuses a provider referring themselves', async () => {
    // The platform would be paying a bonus, out of real fee revenue, for a
    // signup it was getting anyway.
    const { data: own } = await admin
      .from('referral_codes')
      .insert({
        code: referralCodeFrom(Uint8Array.from({ length: 8 }, (_, i) => (stamp + i * 13 + 5) % 251)),
        provider_user_id: customerId,
      })
      .select('code')
      .single()

    const subId = await freshSubscription()
    const r = await attachReferral({
      db: admin,
      subscriptionId: subId,
      customerUserId: customerId,
      code: own!.code,
    })
    expect(r).toEqual({ applied: false, reason: 'SELF_REFERRAL' })

    await admin.from('referral_codes').delete().eq('code', own!.code)
  })
})

describe('the first-cycle discount', () => {
  it('charges the customer the subtotal with no fee', async () => {
    const subId = await freshSubscription()
    await attach(subId)
    await deliverCycle(subId)

    const r = await settleSubscription({ db: admin, subscriptionId: subId, now: AFTER_CYCLE })
    expect(r.ok).toBe(true)

    // $12.00, not $13.80. The whole first-cycle fee was waived.
    expect(charger.requests).toHaveLength(1)
    expect(charger.requests[0]!.amountCents).toBe(SUBTOTAL)
  })

  it('leaves the provider owed their full listed price', async () => {
    // The claim the whole design rests on. CLAUDE.md rule 5: the provider
    // keeps the listed price. A promotion they did not run must not cost
    // them a cent.
    const subId = await freshSubscription()
    await attach(subId)
    await deliverCycle(subId)
    await settleSubscription({ db: admin, subscriptionId: subId, now: AFTER_CYCLE })

    const rows = await ledgerFor(subId)
    expect(byKind(rows, 'provider_earning')).toBe(-SUBTOTAL)
  })

  it('takes the whole discount out of platform revenue', async () => {
    const subId = await freshSubscription()
    await attach(subId)
    await deliverCycle(subId)
    await settleSubscription({ db: admin, subscriptionId: subId, now: AFTER_CYCLE })

    const rows = await ledgerFor(subId)
    expect(byKind(rows, 'platform_fee')).toBe(0)
    expect(byKind(rows, 'customer_charge')).toBe(SUBTOTAL)
  })

  it('still sums to zero', async () => {
    // Every cent taken is assigned to somebody. A discounted cycle is not
    // an excuse for an unbalanced set.
    const subId = await freshSubscription()
    await attach(subId)
    await deliverCycle(subId)
    await settleSubscription({ db: admin, subscriptionId: subId, now: AFTER_CYCLE })

    expect(sum(await ledgerFor(subId))).toBe(0)
  })

  it('is spent exactly once, even though the cycle is re-runnable', async () => {
    const subId = await freshSubscription()
    const referralId = await attach(subId)
    await deliverCycle(subId)

    await settleSubscription({ db: admin, subscriptionId: subId, now: AFTER_CYCLE })
    expect((await referralRow(referralId)).discount_applied_cents).toBe(FEE)

    // Re-running settlement is the documented recovery path. It must not
    // hand out a second discount.
    await settleSubscription({ db: admin, subscriptionId: subId, now: AFTER_CYCLE })
    expect((await referralRow(referralId)).discount_applied_cents).toBe(FEE)
  })

  it('charges the full price on a subscription with no referral', async () => {
    const subId = await freshSubscription()
    await deliverCycle(subId)
    await settleSubscription({ db: admin, subscriptionId: subId, now: AFTER_CYCLE })

    expect(charger.requests[0]!.amountCents).toBe(SUBTOTAL + FEE)
    expect(byKind(await ledgerFor(subId), 'platform_fee')).toBe(-FEE)
  })
})

describe('the provider bonus', () => {
  it('pays the referrer once work has been delivered and charged', async () => {
    const subId = await freshSubscription()
    const referralId = await attach(subId)
    await deliverCycle(subId)
    await settleSubscription({ db: admin, subscriptionId: subId, now: AFTER_CYCLE })

    const run = await runReferralRewards({ db: admin, now: AFTER_CYCLE })
    expect(run.failed).toEqual([])

    const row = await referralRow(referralId)
    expect(row.state).toBe('paid')
    expect(row.qualified_at).not.toBeNull()
    expect(row.paid_at).not.toBeNull()

    // The keyed half of the pair: the platform now owes the referrer $5
    // more, and it is owed to them rather than charged to anybody.
    const rows = await bonusRowsFor(referralId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.kind).toBe('provider_earning')
    expect(rows[0]!.amount_cents).toBe(-500)
    expect(rows[0]!.provider_user_id).toBe(referrerId)
    expect(rows[0]!.subscription_id).toBeNull()
  })

  it('does not pay a second time when the job runs again', async () => {
    // The cron runs every four hours. A bonus that paid on each pass would
    // be an open tap.
    const subId = await freshSubscription()
    const referralId = await attach(subId)
    await deliverCycle(subId)
    await settleSubscription({ db: admin, subscriptionId: subId, now: AFTER_CYCLE })
    await runReferralRewards({ db: admin, now: AFTER_CYCLE })

    await runReferralRewards({ db: admin, now: AFTER_CYCLE })
    // Still one. The ledger's unique index is what refuses the second, so
    // this is asserting the guard rather than the absence of a second call.
    expect(await bonusRowsFor(referralId)).toHaveLength(1)
  })

  it('waits while a subscription has been charged but nothing delivered', async () => {
    // "After qualifying paid occurrence." Paying on the charge alone would
    // buy signups rather than customers.
    const subId = await freshSubscription()
    const referralId = await attach(subId)
    await addOccurrence(subId, '2026-09-01', 'completed')
    await settleSubscription({ db: admin, subscriptionId: subId, now: AFTER_CYCLE })

    // Remove the evidence of delivery, keeping the charge.
    await admin.from('service_occurrences').delete().eq('subscription_id', subId)

    await runReferralRewards({ db: admin, now: AFTER_CYCLE })
    expect((await referralRow(referralId)).state).toBe('pending')
  })

  it('waits while work is delivered but nothing has been charged', async () => {
    const subId = await freshSubscription()
    const referralId = await attach(subId)
    await deliverCycle(subId)

    await runReferralRewards({ db: admin, now: AFTER_CYCLE })
    expect((await referralRow(referralId)).state).toBe('pending')
  })

  it('voids a referral whose subscription was cancelled before any visit', async () => {
    // Otherwise the job re-reads it every four hours for the life of the
    // platform.
    const subId = await freshSubscription()
    const referralId = await attach(subId)
    // canceled_has_timestamp: the table refuses a cancelled row with no
    // time on it, which is right -- "cancelled" with no when is not a
    // record of anything.
    const { error: cancelErr } = await admin
      .from('subscriptions')
      .update({ state: 'canceled', canceled_at: AFTER_CYCLE.toISOString() })
      .eq('id', subId)
    expect(cancelErr).toBeNull()

    const run = await runReferralRewards({ db: admin, now: AFTER_CYCLE })
    expect(run.voided).toBeGreaterThanOrEqual(1)

    const row = await referralRow(referralId)
    expect(row.state).toBe('void')
    expect(row.void_reason).not.toBeNull()
  })

  it('carries no subscription id, so it does not unbalance the referred books', async () => {
    const subId = await freshSubscription()
    await attach(subId)
    await deliverCycle(subId)
    await settleSubscription({ db: admin, subscriptionId: subId, now: AFTER_CYCLE })
    await runReferralRewards({ db: admin, now: AFTER_CYCLE })

    // The referred subscription's own ledger still sums to zero: the bonus
    // belongs to the referrer's balance, not to this customer's books.
    expect(sum(await ledgerFor(subId))).toBe(0)
  })
})

describe('a voided referral', () => {
  it('stops handing out a discount', async () => {
    const subId = await freshSubscription()
    const referralId = await attach(subId)
    await admin
      .from('referrals')
      .update({ state: 'void', voided_at: AFTER_CYCLE.toISOString(), void_reason: 'abuse' })
      .eq('id', referralId)

    await deliverCycle(subId)
    await settleSubscription({ db: admin, subscriptionId: subId, now: AFTER_CYCLE })

    expect(charger.requests[0]!.amountCents).toBe(SUBTOTAL + FEE)
    expect((await referralRow(referralId)).discount_applied_cents).toBeNull()
  })
})
