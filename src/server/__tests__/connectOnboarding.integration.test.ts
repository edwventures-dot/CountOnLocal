/**
 * Stripe Connect onboarding against the live test-mode account.
 *
 * The claim being tested is the one that matters legally: for a 13-17
 * provider the connected account belongs to the GUARDIAN, and there is no
 * path -- through the service or through a direct database write -- that
 * routes money to a minor's own account.
 *
 * Creates real Stripe test accounts and deletes them in afterAll.
 *
 *   npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'
import type { Database } from '@/lib/supabase/types'
import { startProviderOnboarding } from '@/server/providerOnboarding'
import { createGuardianInvitation, acceptGuardianInvitation } from '@/server/guardianService'
import {
  ensurePayoutAccount,
  createOnboardingLink,
  syncAccountState,
} from '@/server/connectOnboarding'
import { payoutStage, canReceivePayments, NO_ACCOUNT } from '@/domain/payout'

const url = process.env['NEXT_PUBLIC_SUPABASE_URL']!
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY']!
const stripeKey = process.env['STRIPE_SECRET_KEY']!

const admin = createClient<Database>(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})
const sdk = new Stripe(stripeKey, { apiVersion: '2026-07-29.dahlia' })

type TestUser = { authId: string; domainId: string; email: string }

const stamp = Date.now()
const MINOR_EMAIL = `pay-minor-${stamp}@example.com`
const GUARDIAN_EMAIL = `pay-guardian-${stamp}@example.com`
const ADULT_EMAIL = `pay-adult-${stamp}@example.com`
const PASSWORD = `Test-${stamp}-Aa1!`

const createdAccounts: string[] = []

async function makeUser(email: string): Promise<TestUser> {
  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  })
  if (error || !created.user) throw new Error(`createUser failed: ${error?.message}`)
  const { data: domainUser, error: readErr } = await admin
    .from('users')
    .select('id')
    .eq('auth_user_id', created.user.id)
    .single()
  if (readErr || !domainUser) throw new Error(`not provisioned: ${readErr?.message}`)
  return { authId: created.user.id, domainId: domainUser.id, email }
}

function dobForAge(years: number): string {
  const d = new Date()
  d.setUTCFullYear(d.getUTCFullYear() - years)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

async function payoutReadyInDb(providerUserId: string): Promise<boolean> {
  const { data } = await admin.rpc('provider_payout_ready' as never, {
    p_provider_user_id: providerUserId,
  } as never)
  return data as unknown as boolean
}

let minor: TestUser
let guardian: TestUser
let adult: TestUser
let relationshipId = ''

beforeAll(async () => {
  minor = await makeUser(MINOR_EMAIL)
  guardian = await makeUser(GUARDIAN_EMAIL)
  adult = await makeUser(ADULT_EMAIL)

  // A 15-year-old with a guardian accepted through to guardian_started.
  await startProviderOnboarding({
    db: admin,
    userId: minor.domainId,
    input: { dateOfBirth: dobForAge(15), countryCode: 'US', displayFirstName: 'Jamie' },
    now: new Date(),
  })
  const invite = await createGuardianInvitation({
    db: admin,
    providerUserId: minor.domainId,
    input: { email: GUARDIAN_EMAIL },
    now: new Date(),
  })
  if (!invite.ok) throw new Error('invitation failed: ' + invite.code)
  relationshipId = invite.relationshipId
  const accepted = await acceptGuardianInvitation({
    adminDb: admin,
    token: invite.token,
    guardianUserId: guardian.domainId,
    now: new Date(),
  })
  if (!accepted.ok) throw new Error('accept failed: ' + accepted.code)

  // An adult provider, for the self-held case.
  await startProviderOnboarding({
    db: admin,
    userId: adult.domainId,
    input: { dateOfBirth: dobForAge(30), countryCode: 'US', displayFirstName: 'Alex' },
    now: new Date(),
  })
})

afterAll(async () => {
  for (const id of createdAccounts) {
    await sdk.v2.core.accounts.close(id, { applied_configurations: ['recipient'] }).catch(() => {})
  }
  for (const u of [minor, guardian, adult]) {
    if (!u) continue
    await admin.from('audit_log').delete().eq('actor_user_id', u.domainId)
    await admin.from('users').delete().eq('id', u.domainId)
    await admin.auth.admin.deleteUser(u.authId)
  }
  if (relationshipId) await admin.from('audit_log').delete().eq('target_id', relationshipId)
})

describe('a minor provider', () => {
  it('gets a connected account owned by the guardian, not by themselves', async () => {
    const result = await ensurePayoutAccount({
      db: admin,
      providerUserId: minor.domainId,
      now: new Date(),
      ip: '203.0.113.10',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    createdAccounts.push(result.accountId)

    expect(result.holder).toBe('guardian')
    expect(result.holderUserId).toBe(guardian.domainId)
    expect(result.holderUserId).not.toBe(minor.domainId)
    expect(result.accountId).toMatch(/^acct_/)
  })

  it('stores the account on the guardian row and leaves the minor with none', async () => {
    const { data: g } = await admin
      .from('users')
      .select('stripe_connected_account_id')
      .eq('id', guardian.domainId)
      .single()
    const { data: m } = await admin
      .from('users')
      .select('stripe_connected_account_id')
      .eq('id', minor.domainId)
      .single()

    expect(g?.stripe_connected_account_id).toMatch(/^acct_/)
    expect(m?.stripe_connected_account_id).toBeNull()
  })

  it('points the provider profile at the guardian as payout holder', async () => {
    const { data } = await admin
      .from('provider_profiles')
      .select('payout_account_user_id')
      .eq('user_id', minor.domainId)
      .single()
    expect(data?.payout_account_user_id).toBe(guardian.domainId)
  })

  it('records the real account holder in Stripe metadata', async () => {
    const acct = await sdk.v2.core.accounts.retrieve(createdAccounts[0]!)
    expect(acct.metadata?.['holder_kind']).toBe('guardian')
    expect(acct.metadata?.['holder_user_id']).toBe(guardian.domainId)
    expect(acct.metadata?.['holds_for_provider_user_id']).toBe(minor.domainId)
  })

  it('configures recipient with transfers only, never merchant', async () => {
    const acct = await sdk.v2.core.accounts.retrieve(createdAccounts[0]!, {
      include: ['configuration.recipient', 'configuration.merchant'],
    })
    expect(acct.configuration?.recipient?.capabilities?.stripe_balance?.stripe_transfers).toBeDefined()
    // No merchant configuration: the guardian never processes a card, so
    // PCI scope and dispute liability stay with the platform. Stripe
    // reports an unconfigured section as null rather than omitting it.
    expect(acct.configuration?.merchant ?? null).toBeNull()
  })

  it('puts fee collection and loss liability on the platform, not the guardian', async () => {
    const acct = await sdk.v2.core.accounts.retrieve(createdAccounts[0]!, { include: ['defaults'] })
    expect(acct.defaults?.responsibilities?.fees_collector).toBe('application')
    expect(acct.defaults?.responsibilities?.losses_collector).toBe('application')
  })

  it('is idempotent -- a second call reuses the same account', async () => {
    const again = await ensurePayoutAccount({
      db: admin,
      providerUserId: minor.domainId,
      now: new Date(),
    })
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.created).toBe(false)
    expect(again.accountId).toBe(createdAccounts[0])
  })
})

describe('the database refuses to route money to a minor', () => {
  it('rejects a direct write making the minor their own payout holder', async () => {
    const { error } = await admin
      .from('provider_profiles')
      .update({ payout_account_user_id: minor.domainId })
      .eq('user_id', minor.domainId)

    expect(error).toBeTruthy()
    expect(error?.message ?? '').toMatch(/adult/i)

    // And the holder is unchanged.
    const { data } = await admin
      .from('provider_profiles')
      .select('payout_account_user_id')
      .eq('user_id', minor.domainId)
      .single()
    expect(data?.payout_account_user_id).toBe(guardian.domainId)
  })
})

describe('onboarding link', () => {
  it('returns a Stripe-hosted URL for the guardian to complete', async () => {
    const result = await createOnboardingLink({
      db: admin,
      providerUserId: minor.domainId,
      returnUrl: 'https://countonlocal.com/payouts/return',
      refreshUrl: 'https://countonlocal.com/payouts/refresh',
      now: new Date(),
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.holder).toBe('guardian')
    expect(result.url).toMatch(/^https:\/\/connect\.stripe\.com\//)
    expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(Date.now())
  })

  it('never writes the link URL into the audit log', async () => {
    const { data } = await admin
      .from('audit_log')
      .select('after_json')
      .eq('action', 'payout.onboarding_link_created')
      .eq('target_id', createdAccounts[0]!)
      .limit(1)
      .maybeSingle()

    expect(JSON.stringify(data?.after_json ?? {})).not.toMatch(/connect\.stripe\.com/)
  })
})

describe('account state is mirrored from Stripe, not assumed', () => {
  it('syncs a brand-new account as not ready, with requirements outstanding', async () => {
    const result = await syncAccountState({
      db: admin,
      accountId: createdAccounts[0]!,
      now: new Date(),
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // A freshly created Express account has not completed onboarding.
    expect(result.stage).not.toBe('ready')
    expect(result.state.payoutsActive).toBe(false)
    expect(result.state.requirementsDue.length).toBeGreaterThan(0)
  })

  it('writes the mirrored state onto the holder', async () => {
    const { data } = await admin
      .from('users')
      .select('stripe_transfers_active, stripe_payouts_active, stripe_requirements_due, stripe_synced_at')
      .eq('id', guardian.domainId)
      .single()

    expect(data?.stripe_payouts_active).toBe(false)
    expect(Array.isArray(data?.stripe_requirements_due)).toBe(true)
    expect(data?.stripe_synced_at).toBeTruthy()
  })

  it('the database agrees the provider is not payout ready', async () => {
    expect(await payoutReadyInDb(minor.domainId)).toBe(false)
  })

  it('returns NOT_FOUND for an account we do not hold', async () => {
    const result = await syncAccountState({
      db: admin,
      accountId: 'acct_neverseen',
      now: new Date(),
    })
    expect(result.ok).toBe(false)
  })
})

describe('an adult provider', () => {
  it('holds their own account', async () => {
    const result = await ensurePayoutAccount({
      db: admin,
      providerUserId: adult.domainId,
      now: new Date(),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    createdAccounts.push(result.accountId)
    expect(result.holder).toBe('self')
    expect(result.holderUserId).toBe(adult.domainId)
  })
})

describe('gating still requires guardian clearance', () => {
  it('blocks payment even once Stripe onboarding is complete, if the guardian is not verified', () => {
    // The minor's guardian is at guardian_started, not verified.
    expect(
      canReceivePayments({
        band: 'minor',
        providerUserId: minor.domainId,
        guardianUserId: guardian.domainId,
        guardianState: 'guardian_started',
        account: {
          accountId: 'acct_x',
          transfersActive: true,
          payoutsActive: true,
          requirementsDue: [],
        },
      }),
    ).toEqual({ allowed: false, code: 'GUARDIAN_APPROVAL_REQUIRED' })
  })

  it('blocks a verified guardian whose Stripe onboarding is unfinished', () => {
    expect(
      canReceivePayments({
        band: 'minor',
        providerUserId: minor.domainId,
        guardianUserId: guardian.domainId,
        guardianState: 'verified',
        account: NO_ACCOUNT,
      }),
    ).toEqual({ allowed: false, code: 'PAYOUT_ONBOARDING_INCOMPLETE' })
    expect(payoutStage(NO_ACCOUNT)).toBe('not_started')
  })
})
