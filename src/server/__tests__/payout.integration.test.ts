/**
 * Paying providers, against the live database and a stubbed processor.
 *
 * The claims are about money, so they are asserted as outcomes: what the
 * ledger says afterwards, and whether a second run moves anything again.
 *
 * The transfer itself is stubbed because completing Stripe Express
 * onboarding needs a browser. The boundary was exercised separately
 * against real Stripe -- an account without the transfers capability is
 * refused, and no ledger row is written when that happens.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'
import { runPayouts } from '@/server/payoutService'
import { setCharger, StubCharger } from '@/server/charger'
import { providerBalanceCents } from '@/domain/ledger'

const admin = createClient<Database>(
  process.env['NEXT_PUBLIC_SUPABASE_URL']!,
  process.env['SUPABASE_SERVICE_ROLE_KEY']!,
  { auth: { persistSession: false, autoRefreshToken: false } },
)

const stamp = Date.now()
let providerId = ''
let guardianId = ''
let charger: StubCharger

async function makeUser(email: string): Promise<string> {
  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    password: `Test-${stamp}-Aa1!`,
    email_confirm: true,
  })
  if (error || !created?.user) throw new Error(`createUser failed: ${error?.message}`)
  const { data } = await admin
    .from('users')
    .select('id')
    .eq('auth_user_id', created.user.id)
    .single()
  return data!.id
}

async function earn(cents: number): Promise<void> {
  const { error } = await admin.from('ledger_entries').insert({
    kind: 'provider_earning',
    amount_cents: -cents,
    currency: 'USD',
    provider_user_id: providerId,
    memo: 'test earnings',
  })
  if (error) throw new Error(error.message)
}

async function ledger() {
  const { data } = await admin
    .from('ledger_entries')
    .select('kind, amount_cents, external_id, idempotency_key')
    .eq('provider_user_id', providerId)
  return data ?? []
}

/**
 * The domain function, not a hand-rolled sum.
 *
 * Rolling my own here produced -0 and a failing assertion, which is the
 * fourth time negative zero has bitten this codebase. providerBalanceCents
 * already normalises it, and reusing it means the test cannot disagree
 * with the thing it is testing.
 */
const balance = (rows: Array<{ kind: string; amount_cents: number }>) =>
  providerBalanceCents(
    rows.map((r) => ({ kind: r.kind, amountCents: r.amount_cents, currency: 'USD' })) as never,
  )

beforeAll(async () => {
  guardianId = await makeUser(`payout-guardian-${stamp}@countonlocal.com`)
  providerId = await makeUser(`payout-minor-${stamp}@countonlocal.com`)

  await admin.from('guardian_profiles').insert({ user_id: guardianId })
  await admin
    .from('users')
    .update({
      stripe_connected_account_id: `acct_test_${stamp}`,
      stripe_transfers_active: true,
      stripe_payouts_active: true,
      stripe_requirements_due: [],
    })
    .eq('id', guardianId)

  // A minor: the money goes to the guardian's account, which is the case
  // worth testing because it is the one the consent describes.
  await admin.from('provider_profiles').insert({
    user_id: providerId,
    date_of_birth: '2011-06-15',
    display_first_name: 'Jo',
    guardian_state: 'verified',
    payout_account_user_id: guardianId,
  })
  await admin.from('guardian_relationships').insert({
    provider_user_id: providerId,
    guardian_user_id: guardianId,
    state: 'verified',
    consented_at: new Date().toISOString(),
    invitation_email: `payout-guardian-${stamp}@countonlocal.com`,
    invitation_expires_at: new Date(Date.now() + 14 * 864e5).toISOString(),
  })
})

beforeEach(() => {
  charger = new StubCharger()
  setCharger(charger)
})

afterAll(async () => {
  for (const id of [providerId, guardianId].filter(Boolean)) {
    await admin.from('ledger_entries').delete().eq('provider_user_id', id)
    await admin.from('notifications').delete().eq('recipient_user_id', id)
    await admin.from('payout_holds').delete().eq('provider_user_id', id)
    await admin.from('guardian_relationships').delete().eq('provider_user_id', id)
    await admin.from('audit_log').delete().eq('target_id', id)
    const { data: u } = await admin.from('users').select('auth_user_id').eq('id', id).maybeSingle()
    await admin.from('users').delete().eq('id', id)
    if (u?.auth_user_id) await admin.auth.admin.deleteUser(u.auth_user_id).catch(() => {})
  }
})

describe('paying what is owed', () => {
  it('sends the whole balance to the guardian account', async () => {
    await earn(1200)
    const r = await runPayouts({ db: admin, now: new Date() })

    expect(r.paid).toBeGreaterThanOrEqual(1)
    const sent = charger.transfers.find((t) => t.amountCents === 1200)
    expect(sent).toBeTruthy()
    // The guardian's account, not the minor's. That is what was consented to.
    expect(sent!.destinationRef).toBe(`acct_test_${stamp}`)
  })

  it('brings the balance to zero', async () => {
    expect(balance(await ledger())).toBe(0)
  })

  it('records the transfer against the ledger row', async () => {
    const payout = (await ledger()).find((e) => e.kind === 'payout')
    expect(payout!.amount_cents).toBe(1200)
    expect(payout!.external_id).toBeTruthy()
  })
})

describe('a second run does not pay again', () => {
  it('moves nothing when nothing new was earned', async () => {
    await runPayouts({ db: admin, now: new Date() })
    expect(charger.transfers).toHaveLength(0)
    expect(balance(await ledger())).toBe(0)
  })

  it('pays only the new amount after more is earned', async () => {
    await earn(300)
    await runPayouts({ db: admin, now: new Date() })

    expect(charger.transfers).toHaveLength(1)
    expect(charger.transfers[0]!.amountCents).toBe(300)
    expect(balance(await ledger())).toBe(0)
  })

  it('uses a different key for the second payout', async () => {
    // The failure this prevents: a date-based key deduplicates the second
    // transfer against the first, no money moves, and a ledger row is
    // written for a payout that did not happen.
    const keys = (await ledger())
      .filter((e) => e.kind === 'payout')
      .map((e) => e.idempotency_key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('what stops a payout', () => {
  it('does not pay while payouts are held', async () => {
    await earn(500)
    const { error } = await admin.from('payout_holds').insert({
      provider_user_id: providerId,
      reason: 'Held for the duration of this test, which is long enough to satisfy the check.',
      placed_by_user_id: guardianId,
    })
    expect(error).toBeNull()

    await runPayouts({ db: admin, now: new Date() })

    // Asserted on this provider's outcome, not on the run's counters:
    // runPayouts sweeps every provider in the database and the totals
    // include whatever else is there.
    expect(charger.transfers.some((t) => t.amountCents === 500)).toBe(false)
    // Still owed. Held is not forfeited.
    expect(balance(await ledger())).toBe(500)
  })

  it('pays once the hold is released', async () => {
    await admin
      .from('payout_holds')
      .update({
        released_at: new Date().toISOString(),
        released_by_user_id: guardianId,
        release_reason: 'test complete',
      })
      .eq('provider_user_id', providerId)

    await runPayouts({ db: admin, now: new Date() })
    expect(charger.transfers[0]?.amountCents).toBe(500)
    expect(balance(await ledger())).toBe(0)
  })

  it('does not pay a provider whose guardian was revoked', async () => {
    await earn(400)
    await admin
      .from('provider_profiles')
      .update({ guardian_state: 'revoked' })
      .eq('user_id', providerId)

    await runPayouts({ db: admin, now: new Date() })

    expect(charger.transfers.some((t) => t.amountCents === 400)).toBe(false)
    // The money is still theirs; a revoked guardian stops it moving, not
    // the earning itself.
    expect(balance(await ledger())).toBe(400)

    await admin
      .from('provider_profiles')
      .update({ guardian_state: 'verified' })
      .eq('user_id', providerId)
  })

  it('writes no ledger row when the processor refuses', async () => {
    // The mirror of Stripe's state can be out of date. When it is, the
    // transfer fails and the books must not claim it happened.
    charger.setTransferOutcome({
      ok: false,
      code: 'error',
      processor: 'stub',
      message: 'destination needs the transfers capability',
    })

    const before = balance(await ledger())
    const payoutsBefore = (await ledger()).filter((e) => e.kind === 'payout').length
    expect(before).toBeGreaterThan(0)

    await runPayouts({ db: admin, now: new Date() })

    // The books must not claim a payout the processor refused. Compared
    // against what was there rather than a fixed number, which is a magic
    // number that goes stale the moment a test is added above.
    expect(balance(await ledger())).toBe(before)
    expect((await ledger()).filter((e) => e.kind === 'payout')).toHaveLength(payoutsBefore)
  })

  it('retries with a fresh key after a refusal, so a cached failure cannot stick', async () => {
    // The bug this closes, found against live Stripe: the idempotency key
    // was the logical payout key, Stripe caches responses under a key for
    // 24 hours INCLUDING failures, and that key does not change until the
    // provider earns more. One transient refusal therefore locked a
    // provider out of payouts entirely, reported as a benign
    // AWAITING_SETTLEMENT skip.
    charger.setTransferOutcome({
      ok: false,
      code: 'insufficient_funds',
      processor: 'stub',
      message: 'not settled yet',
    })
    await earn(700)
    // The whole owed balance, not the 700 just added: this provider carries
    // one forward from the tests above, and hardcoding an amount here made
    // the assertion depend on what ran before it.
    const owed = balance(await ledger())
    await runPayouts({ db: admin, now: new Date() })

    const refused = charger.transfers.filter((t) => t.amountCents === owed)
    expect(refused).toHaveLength(1)

    // Now the balance settles. Same payout, same amount, nothing earned in
    // between -- so the logical key is identical and the Stripe key must
    // not be.
    charger.setTransferOutcome(null)
    await runPayouts({ db: admin, now: new Date() })

    const attempts = charger.transfers.filter((t) => t.amountCents === owed)
    expect(attempts).toHaveLength(2)
    expect(attempts[0]!.groupRef).toBe(attempts[1]!.groupRef)
    expect(attempts[0]!.idempotencyKey).not.toBe(attempts[1]!.idempotencyKey)
    expect(balance(await ledger())).toBe(0)
  })

  it('recovers a transfer that moved money and was never recorded', async () => {
    // The case the stable key used to cover, now covered by asking Stripe.
    // Without this, a fresh key per attempt would pay a second time.
    await earn(450)

    // Stripe says a transfer for this payout already exists.
    const { data: entries } = await admin
      .from('ledger_entries')
      .select('kind, amount_cents')
      .eq('provider_user_id', providerId)
    const owed = balance(entries ?? [])
    const earned = (entries ?? [])
      .filter((e) => e.kind === 'provider_earning')
      .reduce((sum, e) => sum - e.amount_cents, 0)
    charger.existingTransfers.set(`payout:${providerId}:${earned}`, 'tr_already_sent')

    await runPayouts({ db: admin, now: new Date() })

    // No second transfer, and the books now reflect the one that happened.
    expect(charger.transfers.some((t) => t.amountCents === owed)).toBe(false)
    const payout = (await ledger()).find((e) => e.external_id === 'tr_already_sent')
    expect(payout).toBeTruthy()
    expect(balance(await ledger())).toBe(0)
    charger.existingTransfers.clear()
  })

  it('refuses to send when it cannot find out whether it already sent', async () => {
    // An unanswerable question is not a no.
    await earn(325)
    charger.findOutcome = { ok: false, message: 'Stripe unreachable' }

    const r = await runPayouts({ db: admin, now: new Date() })

    expect(charger.transfers.some((t) => t.amountCents === 325)).toBe(false)
    expect(r.failed.map((f) => f.providerUserId)).toContain(providerId)
    // Still owed. Nothing was lost by refusing to guess.
    expect(balance(await ledger())).toBe(325)

    charger.findOutcome = null
    await runPayouts({ db: admin, now: new Date() })
    expect(balance(await ledger())).toBe(0)
  })

  it('treats an unsettled balance as waiting, not as a failure', async () => {
    // Card payments take days to settle. That is a normal condition and
    // the next run finds the same balance and the same key.
    charger.setTransferOutcome({
      ok: false,
      code: 'insufficient_funds',
      processor: 'stub',
      message: 'waiting to settle',
    })

    const before = balance(await ledger())
    const r = await runPayouts({ db: admin, now: new Date() })

    // Waiting, not failing: nothing recorded, nothing lost, and this
    // provider is not reported as a problem for somebody to investigate.
    expect(r.failed.map((f) => f.providerUserId)).not.toContain(providerId)
    expect(balance(await ledger())).toBe(before)
  })
})
