/**
 * A real Stripe transfer, against real Stripe.
 *
 * Product owner's response of 2026-08-30, item 3:
 *
 *   "before treating payouts as production-validated, exercise a
 *    successful real Stripe Connect transfer path."
 *
 * What has already been proven live is the REFUSAL: an account without the
 * transfers capability is rejected and no ledger row is written. The
 * success leg has only ever run against a stubbed processor, because
 * finishing Stripe Express onboarding needs a person in a browser.
 *
 * ## How to run it
 *
 *   npm run test:payout:live
 *
 * The first run creates the provider, gives it a balance, and prints an
 * onboarding URL. Open it and complete it with **Stripe's test values** --
 * this is test mode and the script refuses to start against a live key.
 *
 * Run the same command again afterwards. It syncs the account, moves real
 * money through real Stripe, and checks the transfer landed, the books
 * balance, and a second run does not pay twice.
 *
 * Skipped entirely unless RUN_LIVE_PAYOUT=1, so it never runs in CI or in
 * an ordinary integration pass.
 *
 * ## Why a test file rather than a script
 *
 * The payout path imports through the `@/` alias, which vitest resolves
 * and a bare node script does not. Reimplementing the job in a script to
 * avoid that would mean verifying a copy of the code instead of the code.
 *
 * ## Why the fixture has a fixed email
 *
 * So the second run finds the same provider without a state file to lose.
 * It is reused, not recreated, and the balance is topped up rather than
 * added to.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'
import { createOnboardingLink, syncAccountState } from '@/server/connectOnboarding'
import { runPayouts } from '@/server/payoutService'
import { providerBalanceCents } from '@/domain/ledger'

const ENABLED = process.env['RUN_LIVE_PAYOUT'] === '1'
const FIXTURE_EMAIL = 'payout-live-fixture@countonlocal.com'
const EARNED_CENTS = 1234

const admin = createClient<Database>(
  process.env['NEXT_PUBLIC_SUPABASE_URL'] ?? 'http://unset',
  process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? 'unset',
  { auth: { persistSession: false, autoRefreshToken: false } },
)

let providerUserId = ''

/** Finds the fixture provider, creating it the first time. */
async function ensureFixture(): Promise<string> {
  const { data: existing } = await admin
    .from('users')
    .select('id')
    .eq('email', FIXTURE_EMAIL)
    .maybeSingle()

  if (existing) return existing.id

  const { data: created, error } = await admin.auth.admin.createUser({
    email: FIXTURE_EMAIL,
    password: `Live-${Date.now()}-Aa1!`,
    email_confirm: true,
  })
  if (error || !created?.user) throw new Error(`createUser failed: ${error?.message}`)

  const { data: user } = await admin
    .from('users')
    .select('id')
    .eq('auth_user_id', created.user.id)
    .single()

  // An ADULT provider, so the money goes to their own account and there is
  // no second person to onboard. The minor path differs only in whose
  // account holds the money, and that branch is covered elsewhere.
  const { error: profileError } = await admin.from('provider_profiles').insert({
    user_id: user!.id,
    date_of_birth: '1990-04-01',
    display_first_name: 'Payout',
    guardian_state: 'not_required',
  })
  if (profileError) throw new Error(profileError.message)

  return user!.id
}

async function ledger() {
  const { data } = await admin
    .from('ledger_entries')
    .select('kind, amount_cents, external_id, idempotency_key')
    .eq('provider_user_id', providerUserId)
  return data ?? []
}

const balanceOf = (rows: Array<{ kind: string; amount_cents: number }>) =>
  providerBalanceCents(
    rows.map((r) => ({ kind: r.kind, amountCents: r.amount_cents, currency: 'USD' })) as never,
  )

describe.skipIf(!ENABLED)('a real Stripe transfer', () => {
  beforeAll(async () => {
    const key = process.env['STRIPE_SECRET_KEY'] ?? ''
    // This moves money. A live key here would move somebody's real money.
    if (!key.startsWith('sk_test_')) {
      throw new Error('STRIPE_SECRET_KEY is not a test key. Refusing to run.')
    }
    providerUserId = await ensureFixture()
  })

  it('has an onboarded connected account, or tells you how to get one', async () => {
    const read = async () =>
      (
        await admin
          .from('users')
          .select('stripe_connected_account_id, stripe_transfers_active, stripe_requirements_due')
          .eq('id', providerUserId)
          .single()
      ).data

    // syncAccountState takes the Stripe account id, not ours -- there is
    // nothing to sync until the account exists, which createOnboardingLink
    // below is what creates.
    const before = await read()
    if (before?.stripe_connected_account_id) {
      await syncAccountState({
        db: admin,
        accountId: before.stripe_connected_account_id,
        now: new Date(),
      })
    }

    const user = await read()

    if (user?.stripe_transfers_active) {
      expect(user.stripe_connected_account_id).toBeTruthy()
      return
    }

    const link = await createOnboardingLink({
      db: admin,
      providerUserId,
      returnUrl: 'http://localhost:3000/provider/payouts?done=1',
      refreshUrl: 'http://localhost:3000/provider/payouts',
      now: new Date(),
    })

    const url = link.ok ? link.url : `(link failed: ${link.code})`
    throw new Error(
      [
        '',
        'Stripe onboarding is not finished, so a transfer would be refused.',
        '',
        'Open this and complete it with Stripe TEST values:',
        '',
        `  ${url}`,
        '',
        `Still outstanding: ${JSON.stringify(user?.stripe_requirements_due ?? [])}`,
        '',
        'Then run this again.',
        '',
      ].join('\n'),
    )
  })

  it('moves real money and records it', async () => {
    // Top the balance up to a known amount rather than adding to it, so
    // running this repeatedly does not accumulate.
    const owed = balanceOf(await ledger())
    if (owed < EARNED_CENTS) {
      const { error } = await admin.from('ledger_entries').insert({
        kind: 'provider_earning',
        amount_cents: -(EARNED_CENTS - owed),
        currency: 'USD',
        provider_user_id: providerUserId,
        memo: 'live payout verification',
      })
      if (error) throw new Error(error.message)
    }

    // No stub is installed. This is the real charger against real Stripe,
    // which is the entire point of the file.
    const result = await runPayouts({ db: admin, now: new Date() })
    expect(result.failed.map((f) => f.providerUserId)).not.toContain(providerUserId)

    const rows = await ledger()
    const payout = rows.find((e) => e.kind === 'payout')

    // A real Stripe transfer id, not a stub's.
    expect(payout?.external_id).toMatch(/^tr_/)
    expect(balanceOf(rows)).toBe(0)
  })

  it('does not pay twice', async () => {
    // The failure this catches: a payout key that deduplicates wrongly, so
    // a second run either pays again or writes a row for a transfer Stripe
    // returned from its cache.
    const before = (await ledger()).filter((e) => e.kind === 'payout').length

    await runPayouts({ db: admin, now: new Date() })

    const after = (await ledger()).filter((e) => e.kind === 'payout')
    expect(after).toHaveLength(before)
    expect(balanceOf(await ledger())).toBe(0)
  })
})
