/**
 * Pending to active, against the live database and a stubbed processor.
 *
 * This is where a checkout becomes money, so the claims are about outcomes
 * -- what was charged, what each party ends up holding, and what happens to
 * the row when something fails -- rather than about shapes.
 *
 * The one that matters most is not financial. A minor whose guardian has
 * not reached `verified` cannot take a paying customer (CLAUDE.md rule 2,
 * QA_ACCEPTANCE section 3: "revocation immediately prevents new checkout").
 * `canAcceptNewSubscription` encoded that and was unit-tested, but until
 * this file nothing in a live path called it. The test below is the one
 * that would have caught that.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'
import { activateSubscription, startCardSetup } from '@/server/activationService'
import { attachReferral } from '@/server/referralService'
import { setCharger, StubCharger } from '@/server/charger'
import { referralCodeFrom } from '@/domain/density'

const url = process.env['NEXT_PUBLIC_SUPABASE_URL']!
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY']!
const admin = createClient<Database>(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const stamp = Date.now()
const PRICE = 300
/** 4 weekly visits at $3 = $12.00 subtotal, 15% fee = $1.80, total $13.80. */
const SUBTOTAL = 1200
const FEE = 180
const TOTAL = SUBTOTAL + FEE

const CYCLE_START = '2026-09-01'
const CYCLE_END = '2026-09-28'
const NOW = new Date('2026-08-25T15:00:00Z')

const PM = 'pm_test_card_visa'

let providerId = ''
let customerId = ''
let serviceId = ''
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

/** A pending subscription with a processor customer already on it. */
async function pendingSubscription(opts?: { withCustomerRef?: boolean }): Promise<string> {
  const { data: addr, error: addrErr } = await admin
    .from('customer_addresses')
    .insert({
      customer_user_id: customerId,
      line1: `${600 + addressCursor++} Activation Way`,
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
      state: 'pending',
      provider_price_cents: PRICE,
      price_unit: 'week',
      platform_fee_bps: 1500,
      platform_fee_min_cents: 100,
      billing_cycle_weeks: 4,
      current_cycle_start: CYCLE_START,
      current_cycle_end: CYCLE_END,
      ...(opts?.withCustomerRef === false ? {} : { stripe_customer_id: `cus_act_${stamp}` }),
    })
    .select('id')
    .single()
  if (error) throw new Error(`subscription insert failed: ${error.message}`)
  madeSubs.push(data!.id)

  // The four visits the quote bills for. Activation refuses to charge if
  // these do not match, so every fixture needs them.
  for (const d of ['2026-09-01', '2026-09-08', '2026-09-15', '2026-09-22']) {
    const { error: occErr } = await admin.from('service_occurrences').insert({
      subscription_id: data!.id,
      service_date: d,
      local_timezone: 'America/Chicago',
      state: 'scheduled',
      service_value_cents: PRICE,
    })
    if (occErr) throw new Error(`occurrence insert failed: ${occErr.message}`)
  }

  return data!.id
}

const activate = (subscriptionId: string, actorUserId = customerId) =>
  activateSubscription({
    db: admin,
    subscriptionId,
    actorUserId,
    input: { paymentMethodRef: PM },
    now: NOW,
  })

async function ledgerFor(subId: string) {
  const { data } = await admin
    .from('ledger_entries')
    .select('kind, amount_cents, external_id')
    .eq('subscription_id', subId)
  return data ?? []
}

async function subRow(subId: string) {
  const { data } = await admin
    .from('subscriptions')
    .select('state, started_at, next_charge_at, stripe_payment_method_id')
    .eq('id', subId)
    .single()
  return data!
}

const byKind = (rows: Array<{ kind: string; amount_cents: number }>, kind: string) =>
  rows.filter((r) => r.kind === kind).reduce((a, r) => a + r.amount_cents, 0)
const sum = (rows: Array<{ amount_cents: number }>) => rows.reduce((a, r) => a + r.amount_cents, 0)

type GuardianStateEnum = Database['public']['Tables']['provider_profiles']['Row']['guardian_state']

async function setGuardianState(state: GuardianStateEnum): Promise<void> {
  await admin
    .from('provider_profiles')
    .update({ guardian_state: state })
    .eq('user_id', providerId)
}

async function setDob(dob: string): Promise<void> {
  await admin.from('provider_profiles').update({ date_of_birth: dob }).eq('user_id', providerId)
}

beforeAll(async () => {
  providerId = await makeUser(`act-provider-${stamp}@example.com`)
  customerId = await makeUser(`act-customer-${stamp}@example.com`)

  await admin.from('provider_profiles').insert({
    user_id: providerId,
    date_of_birth: '1990-01-01',
    display_first_name: 'Alex',
    guardian_state: 'not_required',
  })
  // baseProviderChecks asks for the provider permission, which comes from a
  // role row rather than from having a profile.
  await admin.from('user_roles').insert({ user_id: providerId, role: 'provider' })

  const { data: biz } = await admin
    .from('businesses')
    .insert({
      provider_user_id: providerId,
      name: `Activation Test ${stamp}`,
      slug: `activation-test-${stamp}`,
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
})

beforeEach(async () => {
  charger = new StubCharger()
  setCharger(charger)
  await setGuardianState('not_required')
  await setDob('1990-01-01')
  await admin
    .from('provider_services')
    .update({ capacity_rule: { maxAddresses: 500 } })
    .eq('id', serviceId)
})

afterAll(async () => {
  await admin.from('notifications').delete().eq('recipient_user_id', providerId)
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
  const ids = [customerId, providerId].filter(Boolean)
  await admin.from('ledger_entries').delete().in('provider_user_id', ids)
  await admin.from('customer_addresses').delete().in('customer_user_id', ids)
  await admin.from('referral_codes').delete().eq('provider_user_id', providerId)
  for (const id of ids) {
    const { data: u } = await admin.from('users').select('auth_user_id').eq('id', id).maybeSingle()
    await admin.from('audit_log').delete().eq('actor_user_id', id)
    await admin.from('users').delete().eq('id', id)
    if (u?.auth_user_id) await admin.auth.admin.deleteUser(u.auth_user_id).catch(() => {})
  }
})

describe('the happy path', () => {
  it('charges the quoted total and goes active', async () => {
    const subId = await pendingSubscription()
    const r = await activate(subId)

    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.chargedCents).toBe(TOTAL)
    expect(charger.requests).toHaveLength(1)
    expect(charger.requests[0]!.amountCents).toBe(TOTAL)
    expect((await subRow(subId)).state).toBe('active')
  })

  it('tells the provider they have a customer', async () => {
    // Nothing did. A provider would have discovered a new subscriber from
    // tomorrow's route, which is the whole point of the product arriving
    // unannounced.
    const subId = await pendingSubscription()
    await activate(subId)

    const { data } = await admin
      .from('notifications')
      .select('recipient_user_id, preview')
      .eq('kind', 'subscription.new_subscriber')
      .contains('payload', { subscriptionId: subId })

    expect(data).toHaveLength(1)
    expect(data![0]!.recipient_user_id).toBe(providerId)
    // Lock-screen safe: nothing about who subscribed or where they live.
    expect(data![0]!.preview).not.toMatch(/oak|street|@|[0-9]{5}/i)
  })

  it('does not announce the same subscription twice', async () => {
    const subId = await pendingSubscription()
    await activate(subId)
    await activate(subId)

    const { count } = await admin
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('kind', 'subscription.new_subscriber')
      .contains('payload', { subscriptionId: subId })

    expect(count).toBe(1)
  })

  it('keys the charge on the cycle, the same way settlement does', async () => {
    const subId = await pendingSubscription()
    await activate(subId)
    expect(charger.requests[0]!.idempotencyKey).toBe(`charge:${subId}:${CYCLE_START}`)
  })

  it('leaves the provider owed exactly their listed price', async () => {
    const subId = await pendingSubscription()
    await activate(subId)

    const rows = await ledgerFor(subId)
    expect(byKind(rows, 'provider_earning')).toBe(-SUBTOTAL)
    expect(byKind(rows, 'platform_fee')).toBe(-FEE)
    expect(byKind(rows, 'customer_charge')).toBe(TOTAL)
    expect(sum(rows)).toBe(0)
  })

  it('records the processor charge against the ledger', async () => {
    const subId = await pendingSubscription()
    const r = await activate(subId)
    if (!r.ok) throw new Error('expected activation to succeed')

    const charge = (await ledgerFor(subId)).find((e) => e.kind === 'customer_charge')
    expect(charge!.external_id).toBe(r.externalId)
  })

  it('stores the payment method and stamps the start', async () => {
    const subId = await pendingSubscription()
    await activate(subId)

    const row = await subRow(subId)
    expect(row.stripe_payment_method_id).toBe(PM)
    expect(row.started_at).not.toBeNull()
    expect(row.next_charge_at).not.toBeNull()
  })
})

describe('the guardian gate', () => {
  // CLAUDE.md rule 2. This is the call site that did not exist before.
  it.each([
    'required_uninvited',
    'invited',
    'guardian_started',
    'revoked',
    'expired',
  ] as const)(
    'refuses a minor whose guardian state is %s',
    async (state) => {
      await setDob('2011-04-02')
      await setGuardianState(state)

      const subId = await pendingSubscription()
      const r = await activate(subId)

      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe('GUARDIAN_APPROVAL_REQUIRED')
    },
  )

  it('takes no money when it refuses', async () => {
    await setDob('2011-04-02')
    await setGuardianState('revoked')

    const subId = await pendingSubscription()
    await activate(subId)

    expect(charger.requests).toHaveLength(0)
    expect(await ledgerFor(subId)).toHaveLength(0)
    expect((await subRow(subId)).state).toBe('pending')
  })

  it('allows a minor once the guardian is verified', async () => {
    await setDob('2011-04-02')
    await setGuardianState('verified')

    const subId = await pendingSubscription()
    const r = await activate(subId)
    expect(r.ok).toBe(true)
  })

  it('does not tell the customer why', async () => {
    // SAFETY_TRUST_POLICY keeps a provider's age and guardian state off
    // public surfaces, and an error message shown to a stranger is one.
    await setDob('2011-04-02')
    await setGuardianState('revoked')

    const subId = await pendingSubscription()
    const r = await activate(subId)

    if (!r.ok) {
      expect(r.message).toBe('This service is not taking new customers right now.')
      expect(r.message).not.toMatch(/guardian|minor|age|13|17/i)
    }
  })
})

describe('a route that filled up while the customer was paying', () => {
  it('refuses, and charges nothing', async () => {
    const subId = await pendingSubscription()
    // One seat, and a different pending subscription already holds it.
    await pendingSubscription()
    await admin
      .from('provider_services')
      .update({ capacity_rule: { maxAddresses: 1 } })
      .eq('id', serviceId)

    const r = await activate(subId)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('AT_CAPACITY')
    expect(charger.requests).toHaveLength(0)
  })

  it('does not count the customer against their own seat', async () => {
    // The pending row already exists and already counts as live. Comparing
    // the raw total to the maximum would refuse the last seat to the person
    // holding it.
    const subId = await pendingSubscription()

    // Exactly as many seats as there are live subscriptions right now,
    // this one included. Counting it would see full; excluding it sees one
    // seat free, which is the seat it is sitting in.
    const { count } = await admin
      .from('subscriptions')
      .select('id', { count: 'exact', head: true })
      .eq('provider_service_id', serviceId)
      .in('state', ['pending', 'active', 'paused', 'payment_failed'])

    await admin
      .from('provider_services')
      .update({ capacity_rule: { maxAddresses: count } })
      .eq('id', serviceId)

    const r = await activate(subId)
    expect(r.ok).toBe(true)
  })
})

describe('a declined card', () => {
  it('leaves the subscription pending and the ledger empty', async () => {
    charger.setOutcome({
      ok: false,
      code: 'declined',
      processor: 'stub',
      message: 'The card was declined.',
    })

    const subId = await pendingSubscription()
    const r = await activate(subId)

    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('CARD_DECLINED')
    // Pending, not payment_failed: that state is for an established
    // subscription whose renewal failed, and this one was never active.
    expect((await subRow(subId)).state).toBe('pending')
    expect(await ledgerFor(subId)).toHaveLength(0)
  })

  it('can be retried with a card that works', async () => {
    charger.setOutcome({ ok: false, code: 'declined', processor: 'stub', message: 'no' })
    const subId = await pendingSubscription()
    await activate(subId)

    charger.setOutcome({ ok: true, processor: 'stub', externalId: 'pi_second_try' })
    const r = await activate(subId)

    expect(r.ok).toBe(true)
    expect((await subRow(subId)).state).toBe('active')
    expect(sum(await ledgerFor(subId))).toBe(0)
  })
})

describe('calling twice', () => {
  it('does not charge a second time', async () => {
    const subId = await pendingSubscription()
    await activate(subId)

    const second = await activate(subId)
    // The state machine refuses before anything reaches the processor: the
    // subscription is already active.
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.code).toBe('NOT_PENDING')
    expect(charger.requests).toHaveLength(1)
    expect(byKind(await ledgerFor(subId), 'customer_charge')).toBe(TOTAL)
  })
})

describe('a referral', () => {
  it('waives the first-cycle fee at activation', async () => {
    const code = referralCodeFrom(
      Uint8Array.from({ length: 8 }, (_, i) => (stamp + i * 11 + 3) % 251),
    )
    await admin.from('referral_codes').insert({ code, provider_user_id: providerId })

    // A different household's referral: the customer here is not the code
    // owner, which referral_is_not_self requires.
    const referrer = await makeUser(`act-referrer-${stamp}@example.com`)
    await admin.from('referral_codes').update({ provider_user_id: referrer }).eq('code', code)

    const subId = await pendingSubscription()
    const attached = await attachReferral({
      db: admin,
      subscriptionId: subId,
      customerUserId: customerId,
      code,
    })
    if (!attached.applied) throw new Error(`attach failed: ${attached.reason}`)
    madeReferrals.push(attached.referralId)

    const r = await activate(subId)
    expect(r.ok).toBe(true)
    if (!r.ok) return

    // $12.00, not $13.80 -- and the provider is still owed the full $12.00.
    expect(r.chargedCents).toBe(SUBTOTAL)
    expect(r.referralDiscountCents).toBe(FEE)
    expect(byKind(await ledgerFor(subId), 'provider_earning')).toBe(-SUBTOTAL)

    await admin.from('referral_codes').delete().eq('code', code)
    const { data: u } = await admin
      .from('users')
      .select('auth_user_id')
      .eq('id', referrer)
      .maybeSingle()
    await admin.from('users').delete().eq('id', referrer)
    if (u?.auth_user_id) await admin.auth.admin.deleteUser(u.auth_user_id).catch(() => {})
  })
})

describe('guards', () => {
  it('refuses somebody else paying for a subscription', async () => {
    const subId = await pendingSubscription()
    const r = await activate(subId, providerId)

    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('NOT_YOUR_SUBSCRIPTION')
    expect(charger.requests).toHaveLength(0)
  })

  it('refuses when the scheduled visits do not match the quote', async () => {
    // Charging for four visits when three are on the calendar is
    // overcharging, however small the gap.
    const subId = await pendingSubscription()
    await admin
      .from('service_occurrences')
      .delete()
      .eq('subscription_id', subId)
      .eq('service_date', '2026-09-22')

    const r = await activate(subId)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('QUOTE_MISMATCH')
    expect(charger.requests).toHaveLength(0)
  })

  it('refuses to charge before card setup has run', async () => {
    const subId = await pendingSubscription({ withCustomerRef: false })
    const r = await activate(subId)

    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('PROCESSOR_ERROR')
    expect(charger.requests).toHaveLength(0)
  })
})

describe('card setup', () => {
  it('creates a processor customer once and reuses it', async () => {
    const subId = await pendingSubscription({ withCustomerRef: false })

    const first = await startCardSetup({ db: admin, subscriptionId: subId, actorUserId: customerId })
    expect(first.ok).toBe(true)
    expect(charger.customers).toHaveLength(1)

    const second = await startCardSetup({
      db: admin,
      subscriptionId: subId,
      actorUserId: customerId,
    })
    expect(second.ok).toBe(true)
    // Still one. A customer who abandons the form and comes back must not
    // accumulate a processor record per attempt.
    expect(charger.customers).toHaveLength(1)
  })

  it('keys the customer on the person, not the subscription', async () => {
    const subId = await pendingSubscription({ withCustomerRef: false })
    await startCardSetup({ db: admin, subscriptionId: subId, actorUserId: customerId })
    expect(charger.customers[0]!.idempotencyKey).toBe(`customer:${customerId}`)
  })

  it('refuses on a subscription that is already active', async () => {
    const subId = await pendingSubscription()
    await activate(subId)

    const r = await startCardSetup({ db: admin, subscriptionId: subId, actorUserId: customerId })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('NOT_PENDING')
  })

  it('refuses somebody else', async () => {
    const subId = await pendingSubscription()
    const r = await startCardSetup({ db: admin, subscriptionId: subId, actorUserId: providerId })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('NOT_YOUR_SUBSCRIPTION')
  })
})
