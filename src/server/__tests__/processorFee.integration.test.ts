/**
 * Processor fee reconciliation, against the live database.
 *
 * The claims are about money, so they are asserted as outcomes -- what each
 * party ends up holding -- rather than as row shapes. That distinction is
 * the whole reason this code exists: the ledger's shape was already correct
 * and summed to zero while the platform's income was overstated by whatever
 * Stripe took, because the missing rows were missing rather than wrong.
 *
 *   - a charge gets its fee recorded exactly once, however often the job runs;
 *   - the provider is owed the same before and after -- rule 5;
 *   - the customer's charge is untouched;
 *   - platform revenue goes from gross to net;
 *   - the subscription's ledger still sums to zero;
 *   - a pending fee writes nothing and is retried, rather than recording zero.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'
import { setCharger, StubCharger } from '@/server/charger'
import { runProcessorFeeReconciliation } from '@/server/processorFeeJob'
import { chargeEntries } from '@/domain/ledger'
import { writeBalancedEntries } from '@/server/ledgerWriter'
import { quoteCycle } from '@/domain/money'

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
let charger: StubCharger

const madeSubs: string[] = []
let addressCursor = 0

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
      line1: `${400 + addressCursor++} Procfee Ave`,
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
      current_cycle_start: '2026-09-01',
      current_cycle_end: '2026-09-28',
      stripe_customer_id: `cus_test_${stamp}`,
      stripe_payment_method_id: `pm_test_${stamp}`,
    })
    .select('id')
    .single()
  if (error) throw new Error(`subscription insert failed: ${error.message}`)
  madeSubs.push(data!.id)
  return data!.id
}

/** A settled cycle charge, the thing reconciliation goes looking for. */
async function postCharge(subId: string, externalId: string) {
  const quote = quoteCycle({ priceCents: PRICE, priceUnit: 'week', billingCycleWeeks: 4 })
  const entries = chargeEntries({
    quote,
    subscriptionId: subId,
    customerUserId: customerId,
    providerUserId: providerId,
    externalProcessor: 'stripe',
    externalId,
    idempotencyKey: `charge:${subId}:2026-09-01`,
  })
  const written = await writeBalancedEntries({ db: admin, entries })
  if (!written.ok) throw new Error(`charge write failed: ${written.message}`)
  return quote
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

beforeAll(async () => {
  providerId = await makeUser(`procfee-provider-${stamp}@example.com`)
  customerId = await makeUser(`procfee-customer-${stamp}@example.com`)

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
      name: `Procfee Test ${stamp}`,
      slug: `procfee-test-${stamp}`,
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

beforeEach(() => {
  charger = new StubCharger()
  setCharger(charger)
})

afterAll(async () => {
  if (madeSubs.length) {
    await admin.from('ledger_entries').delete().in('subscription_id', madeSubs)
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

describe('recording what the processor kept', () => {
  it('turns gross platform revenue into net, and leaves everyone else alone', async () => {
    const subId = await freshSubscription()
    const externalId = `pi_procfee_${stamp}_1`
    const quote = await postCharge(subId, externalId)

    const before = await ledgerFor(subId)
    expect(sum(before)).toBe(0)
    expect(byKind(before, 'platform_fee')).toBe(-quote.platformFeeCents)
    const earnedBefore = byKind(before, 'provider_earning')
    const paidBefore = byKind(before, 'customer_charge')

    charger.setFeeOutcome({ ok: true, state: 'settled', feeCents: 65, currency: 'USD' })
    const run = await runProcessorFeeReconciliation({ db: admin })
    expect(run.recorded).toBeGreaterThanOrEqual(1)
    expect(run.feesRecordedCents).toBeGreaterThanOrEqual(65)

    const after = await ledgerFor(subId)

    // The property everything rests on.
    expect(sum(after)).toBe(0)

    // Rule 5: the provider keeps the listed price. Untouched.
    expect(byKind(after, 'provider_earning')).toBe(earnedBefore)

    // The customer paid what they paid.
    expect(byKind(after, 'customer_charge')).toBe(paidBefore)

    // The platform's share is smaller by exactly what the processor took.
    expect(byKind(after, 'processor_fee')).toBe(-65)
    expect(byKind(after, 'platform_fee')).toBe(-quote.platformFeeCents + 65)
  })

  it('records a fee once, however many times the job runs', async () => {
    const subId = await freshSubscription()
    await postCharge(subId, `pi_procfee_${stamp}_2`)

    charger.setFeeOutcome({ ok: true, state: 'settled', feeCents: 42, currency: 'USD' })
    await runProcessorFeeReconciliation({ db: admin })
    const once = await ledgerFor(subId)

    // Three more times, including a fresh charger with no memory of the first.
    charger = new StubCharger()
    setCharger(charger)
    charger.setFeeOutcome({ ok: true, state: 'settled', feeCents: 42, currency: 'USD' })
    await runProcessorFeeReconciliation({ db: admin })
    await runProcessorFeeReconciliation({ db: admin })
    await runProcessorFeeReconciliation({ db: admin })

    const later = await ledgerFor(subId)
    expect(byKind(later, 'processor_fee')).toBe(byKind(once, 'processor_fee'))
    expect(byKind(later, 'processor_fee')).toBe(-42)
    expect(later.filter((r) => r.kind === 'processor_fee')).toHaveLength(1)
    expect(sum(later)).toBe(0)
  })

  it('writes nothing while the processor has not settled, and picks it up later', async () => {
    const subId = await freshSubscription()
    await postCharge(subId, `pi_procfee_${stamp}_3`)

    charger.setFeeOutcome({ ok: true, state: 'pending' })
    const first = await runProcessorFeeReconciliation({ db: admin })
    expect(first.pending).toBeGreaterThanOrEqual(1)

    const during = await ledgerFor(subId)
    // A zero fee row here would be a lie that never corrects itself: the
    // key would be taken and no later run would revisit it.
    expect(during.filter((r) => r.kind === 'processor_fee')).toHaveLength(0)
    expect(sum(during)).toBe(0)

    charger.setFeeOutcome({ ok: true, state: 'settled', feeCents: 55, currency: 'USD' })
    await runProcessorFeeReconciliation({ db: admin })

    const after = await ledgerFor(subId)
    expect(byKind(after, 'processor_fee')).toBe(-55)
    expect(sum(after)).toBe(0)
  })

  it('leaves the books gross rather than wrong when the processor cannot answer', async () => {
    const subId = await freshSubscription()
    await postCharge(subId, `pi_procfee_${stamp}_4`)

    charger.setFeeOutcome({ ok: false, message: 'Stripe is having a day' })
    const run = await runProcessorFeeReconciliation({ db: admin })
    expect(run.failed).toBeGreaterThanOrEqual(1)
    expect(run.errors.join(' ')).toMatch(/having a day/)

    const after = await ledgerFor(subId)
    expect(after.filter((r) => r.kind === 'processor_fee')).toHaveLength(0)
    expect(sum(after)).toBe(0)
  })

  it('refuses to convert a currency it was not given a rate for', async () => {
    const subId = await freshSubscription()
    await postCharge(subId, `pi_procfee_${stamp}_5`)

    charger.setFeeOutcome({ ok: true, state: 'settled', feeCents: 70, currency: 'EUR' })
    const run = await runProcessorFeeReconciliation({ db: admin })
    expect(run.errors.join(' ')).toMatch(/EUR/)

    const after = await ledgerFor(subId)
    expect(after.filter((r) => r.kind === 'processor_fee')).toHaveLength(0)
    expect(sum(after)).toBe(0)
  })
})
