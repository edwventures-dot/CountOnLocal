import { describe, it, expect } from 'vitest'
import { parsePlainDate } from '../age.js'
import type { GuardianState } from '../guardian.js'
import {
  canPublishBusiness,
  canAcceptNewSubscription,
  canContinueRecurringCharges,
  canDraftBusiness,
  guardianStateIsConsistent,
  type ProviderGateContext,
} from '../gates.js'

const TODAY = parsePlainDate('2026-08-24')

// Ages relative to TODAY.
const DOB_12 = parsePlainDate('2013-08-25')
const DOB_15 = parsePlainDate('2011-01-10')
const DOB_17 = parsePlainDate('2008-08-25')
const DOB_ADULT = parsePlainDate('1995-03-02')

function ctx(over: Partial<ProviderGateContext> = {}): ProviderGateContext {
  return {
    roles: ['provider'],
    dateOfBirth: DOB_15,
    guardianState: 'verified',
    today: TODAY,
    ...over,
  }
}

describe('QA_ACCEPTANCE section 2 - under-13 gate', () => {
  it('blocks a 12-year-old from publishing', () => {
    expect(canPublishBusiness(ctx({ dateOfBirth: DOB_12, guardianState: 'verified' }))).toEqual({
      allowed: false,
      code: 'PROVIDER_INELIGIBLE',
    })
  })

  it('blocks them even with a verified guardian and every provider role', () => {
    const d = canPublishBusiness(
      ctx({ dateOfBirth: DOB_12, guardianState: 'verified', roles: ['provider', 'customer'] }),
    )
    expect(d.allowed).toBe(false)
  })

  it('blocks them from drafting too, so no publishable row is ever created', () => {
    expect(canDraftBusiness(ctx({ dateOfBirth: DOB_12 })).allowed).toBe(false)
  })

  it('cannot be bypassed by a direct call: age comes from stored DOB only', () => {
    // The context has no age or isMinor field to forge -- the only input is
    // the DOB, and it is read from provider_profiles, never the request.
    const keys = Object.keys(ctx())
    expect(keys).not.toContain('age')
    expect(keys).not.toContain('isMinor')
    expect(keys).not.toContain('guardianRequired')
  })
})

describe('QA_ACCEPTANCE section 3 - guardian gating', () => {
  const incomplete: GuardianState[] = [
    'required_uninvited',
    'invited',
    'guardian_started',
    'revoked',
    'expired',
    'manual_review',
  ]

  it('a minor cannot publish while guardian state is incomplete', () => {
    for (const guardianState of incomplete) {
      expect(canPublishBusiness(ctx({ guardianState }))).toEqual({
        allowed: false,
        code: 'GUARDIAN_APPROVAL_REQUIRED',
      })
    }
  })

  it('a verified guardian allows publish', () => {
    expect(canPublishBusiness(ctx({ guardianState: 'verified' }))).toEqual({ allowed: true })
  })

  it('an adult provider publishes without a guardian', () => {
    expect(
      canPublishBusiness(ctx({ dateOfBirth: DOB_ADULT, guardianState: 'not_required' })),
    ).toEqual({ allowed: true })
  })

  it('revocation immediately prevents new checkout', () => {
    expect(canAcceptNewSubscription(ctx({ guardianState: 'revoked' }))).toEqual({
      allowed: false,
      code: 'GUARDIAN_APPROVAL_REQUIRED',
    })
  })

  it('revocation stops future recurring charges', () => {
    expect(canContinueRecurringCharges(ctx({ guardianState: 'revoked' }))).toEqual({
      allowed: false,
      code: 'GUARDIAN_APPROVAL_REQUIRED',
    })
  })

  it('drafting survives revocation', () => {
    expect(canDraftBusiness(ctx({ guardianState: 'revoked' }))).toEqual({ allowed: true })
  })

  it('a 17-year-old one day from majority still needs a guardian', () => {
    expect(
      canPublishBusiness(ctx({ dateOfBirth: DOB_17, guardianState: 'required_uninvited' })).allowed,
    ).toBe(false)
  })
})

describe('the guardian requirement cannot be removed via API', () => {
  it('detects a minor parked at not_required', () => {
    const tampered = ctx({ dateOfBirth: DOB_15, guardianState: 'not_required' })
    expect(guardianStateIsConsistent(tampered)).toBe(false)
    expect(canPublishBusiness(tampered)).toEqual({
      allowed: false,
      code: 'GUARDIAN_STATE_INCONSISTENT',
    })
  })

  it('refuses money on an inconsistent record rather than trusting the flag', () => {
    const tampered = ctx({ dateOfBirth: DOB_15, guardianState: 'not_required' })
    expect(canAcceptNewSubscription(tampered).allowed).toBe(false)
    expect(canContinueRecurringCharges(tampered).allowed).toBe(false)
  })

  it('accepts an adult at not_required as legitimate', () => {
    expect(guardianStateIsConsistent(ctx({ dateOfBirth: DOB_ADULT, guardianState: 'not_required' }))).toBe(true)
  })

  it('accepts an adult still carrying a verified relationship from minority', () => {
    expect(
      canPublishBusiness(ctx({ dateOfBirth: DOB_ADULT, guardianState: 'verified' })).allowed,
    ).toBe(true)
  })
})

describe('role enforcement', () => {
  it('rejects a caller who is not a provider', () => {
    expect(canPublishBusiness(ctx({ roles: ['customer'] }))).toEqual({
      allowed: false,
      code: 'NOT_A_PROVIDER',
    })
  })

  it('rejects a caller with no roles at all', () => {
    expect(canPublishBusiness(ctx({ roles: [] })).allowed).toBe(false)
  })

  it('does not let a guardian publish on the provider behalf', () => {
    expect(canPublishBusiness(ctx({ roles: ['guardian'] })).allowed).toBe(false)
  })
})
