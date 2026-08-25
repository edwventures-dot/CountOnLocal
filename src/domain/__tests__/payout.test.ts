import { describe, it, expect } from 'vitest'
import {
  resolvePayoutHolder,
  payoutStage,
  isPayoutReady,
  canReceivePayments,
  NO_ACCOUNT,
  type StripeAccountState,
} from '../payout.js'
import type { GuardianState } from '../guardian.js'

const PROVIDER = 'provider-uuid'
const GUARDIAN = 'guardian-uuid'

const READY: StripeAccountState = {
  accountId: 'acct_123',
  transfersActive: true,
  payoutsActive: true,
  requirementsDue: [],
}

describe('who holds the payout account', () => {
  it('an adult provider holds their own', () => {
    expect(
      resolvePayoutHolder({
        band: 'adult',
        providerUserId: PROVIDER,
        guardianUserId: null,
        guardianState: 'not_required',
      }),
    ).toEqual({ ok: true, holder: 'self', holderUserId: PROVIDER })
  })

  it('a minor uses their guardian once the guardian is attached', () => {
    for (const guardianState of ['guardian_started', 'verified'] as GuardianState[]) {
      expect(
        resolvePayoutHolder({
          band: 'minor',
          providerUserId: PROVIDER,
          guardianUserId: GUARDIAN,
          guardianState,
        }),
      ).toEqual({ ok: true, holder: 'guardian', holderUserId: GUARDIAN })
    }
  })

  it('never lets a minor hold their own account', () => {
    const states: GuardianState[] = [
      'required_uninvited',
      'invited',
      'guardian_started',
      'verified',
      'revoked',
      'expired',
      'manual_review',
    ]
    for (const guardianState of states) {
      const r = resolvePayoutHolder({
        band: 'minor',
        providerUserId: PROVIDER,
        guardianUserId: GUARDIAN,
        guardianState,
      })
      if (r.ok) expect(r.holderUserId).not.toBe(PROVIDER)
    }
  })

  it('refuses when a minor has no guardian attached yet', () => {
    for (const guardianState of ['required_uninvited', 'invited'] as GuardianState[]) {
      expect(
        resolvePayoutHolder({
          band: 'minor',
          providerUserId: PROVIDER,
          guardianUserId: null,
          guardianState,
        }),
      ).toEqual({ ok: false, code: 'GUARDIAN_NOT_LINKED' })
    }
  })

  it('refuses a revoked or expired guardian even if an id lingers', () => {
    for (const guardianState of ['revoked', 'expired'] as GuardianState[]) {
      expect(
        resolvePayoutHolder({
          band: 'minor',
          providerUserId: PROVIDER,
          guardianUserId: GUARDIAN,
          guardianState,
        }),
      ).toEqual({ ok: false, code: 'GUARDIAN_NOT_LINKED' })
    }
  })

  it('refuses an under-age provider outright', () => {
    expect(
      resolvePayoutHolder({
        band: 'under_min_age',
        providerUserId: PROVIDER,
        guardianUserId: GUARDIAN,
        guardianState: 'verified',
      }),
    ).toEqual({ ok: false, code: 'PROVIDER_INELIGIBLE' })
  })
})

describe('payout stage', () => {
  it('reports not_started with no account', () => {
    expect(payoutStage(NO_ACCOUNT)).toBe('not_started')
  })

  it('reports ready when both capabilities are active', () => {
    expect(payoutStage(READY)).toBe('ready')
    expect(payoutStage({ ...READY, transfersActive: false })).toBe('requirements_due')
    expect(payoutStage({ ...READY, payoutsActive: false })).toBe('requirements_due')
  })

  it('does not block on outstanding requirements when Stripe says the capability is active', () => {
    // Stripe keeps a capability active while future-dated requirements are
    // outstanding. Gating on the list would strand a working account.
    expect(payoutStage({ ...READY, requirementsDue: ['defaults.profile.business_url'] })).toBe(
      'ready',
    )
  })

  it('refuses an account that can receive transfers but cannot pay out', () => {
    // Otherwise money accumulates against a provider who can never be paid.
    expect(isPayoutReady({ ...READY, payoutsActive: false })).toBe(false)
  })
})

describe('canReceivePayments', () => {
  const minor = {
    band: 'minor' as const,
    providerUserId: PROVIDER,
    guardianUserId: GUARDIAN,
  }

  it('allows a verified minor with a ready account', () => {
    expect(canReceivePayments({ ...minor, guardianState: 'verified', account: READY })).toEqual({
      allowed: true,
    })
  })

  it('blocks when the guardian is only part-way through', () => {
    expect(
      canReceivePayments({ ...minor, guardianState: 'guardian_started', account: READY }),
    ).toEqual({ allowed: false, code: 'GUARDIAN_APPROVAL_REQUIRED' })
  })

  it('blocks a verified guardian whose Stripe capabilities are still restricted', () => {
    expect(
      canReceivePayments({
        ...minor,
        guardianState: 'verified',
        account: { ...READY, transfersActive: false, payoutsActive: false },
      }),
    ).toEqual({ allowed: false, code: 'PAYOUT_ONBOARDING_INCOMPLETE' })
  })

  it('blocks immediately on revocation even with a fully onboarded account', () => {
    expect(canReceivePayments({ ...minor, guardianState: 'revoked', account: READY })).toEqual({
      allowed: false,
      code: 'GUARDIAN_NOT_LINKED',
    })
  })

  it('allows an adult provider with no guardian at all', () => {
    expect(
      canReceivePayments({
        band: 'adult',
        providerUserId: PROVIDER,
        guardianUserId: null,
        guardianState: 'not_required',
        account: READY,
      }),
    ).toEqual({ allowed: true })
  })

  it('blocks an adult who has not started onboarding', () => {
    expect(
      canReceivePayments({
        band: 'adult',
        providerUserId: PROVIDER,
        guardianUserId: null,
        guardianState: 'not_required',
        account: NO_ACCOUNT,
      }),
    ).toEqual({ allowed: false, code: 'PAYOUT_ONBOARDING_INCOMPLETE' })
  })
})
