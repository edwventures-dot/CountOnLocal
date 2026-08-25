import { describe, it, expect } from 'vitest'
import {
  transition,
  initialGuardianState,
  guardianCapabilities,
  isGuardianCleared,
  PROVIDER_FACING_GUARDIAN_BLOCK,
  type GuardianState,
  type GuardianEvent,
} from '../guardian.js'

const ALL_STATES: GuardianState[] = [
  'not_required',
  'required_uninvited',
  'invited',
  'guardian_started',
  'verified',
  'revoked',
  'expired',
  'manual_review',
]

const ALL_EVENTS: GuardianEvent[] = [
  'INVITE',
  'RESEND_INVITE',
  'GUARDIAN_OPENED',
  'VERIFY',
  'REVOKE',
  'EXPIRE',
  'FLAG_FOR_REVIEW',
  'REVIEW_APPROVE',
  'REVIEW_DENY',
  'AGED_OUT',
]

describe('initial state', () => {
  it('adults need no guardian; minors start uninvited', () => {
    expect(initialGuardianState('adult')).toBe('not_required')
    expect(initialGuardianState('minor')).toBe('required_uninvited')
  })
})

describe('the happy path', () => {
  it('walks uninvited to verified', () => {
    let s: GuardianState = 'required_uninvited'
    for (const e of ['INVITE', 'GUARDIAN_OPENED', 'VERIFY'] as GuardianEvent[]) {
      const r = transition(s, e)
      expect(r.ok).toBe(true)
      if (r.ok) s = r.to
    }
    expect(s).toBe('verified')
    expect(isGuardianCleared(s)).toBe(true)
  })
})

describe('recovery paths', () => {
  it('lets an expired invitation be reissued', () => {
    const r = transition('expired', 'INVITE')
    expect(r.ok && r.to).toBe('invited')
  })

  it('lets a revoked relationship be restarted', () => {
    const r = transition('revoked', 'INVITE')
    expect(r.ok && r.to).toBe('invited')
  })

  it('resolves manual review either way', () => {
    expect(transition('manual_review', 'REVIEW_APPROVE')).toMatchObject({ to: 'verified' })
    expect(transition('manual_review', 'REVIEW_DENY')).toMatchObject({ to: 'revoked' })
  })
})

describe('illegal transitions are rejected, not thrown', () => {
  it('cannot verify straight from uninvited', () => {
    const r = transition('required_uninvited', 'VERIFY')
    expect(r).toEqual({
      ok: false,
      from: 'required_uninvited',
      event: 'VERIFY',
      code: 'ILLEGAL_GUARDIAN_TRANSITION',
    })
  })

  it('cannot leave not_required by any event except staying put', () => {
    for (const e of ALL_EVENTS) {
      expect(transition('not_required', e).ok).toBe(false)
    }
  })

  it('cannot un-revoke directly to verified', () => {
    expect(transition('revoked', 'VERIFY').ok).toBe(false)
    expect(transition('revoked', 'REVIEW_APPROVE').ok).toBe(false)
  })

  it('never produces a state outside the declared set', () => {
    for (const s of ALL_STATES) {
      for (const e of ALL_EVENTS) {
        const r = transition(s, e)
        if (r.ok) expect(ALL_STATES).toContain(r.to)
      }
    }
  })

  it('is total: every state/event pair returns a decision', () => {
    for (const s of ALL_STATES) {
      for (const e of ALL_EVENTS) {
        expect(typeof transition(s, e).ok).toBe('boolean')
      }
    }
  })
})

describe('capabilities - only verified and not_required are cleared', () => {
  it('clears exactly two states', () => {
    const cleared = ALL_STATES.filter(isGuardianCleared)
    expect(cleared.sort()).toEqual(['not_required', 'verified'])
  })

  it('allows drafting in every state, including revoked', () => {
    for (const s of ALL_STATES) {
      expect(guardianCapabilities(s).canDraftBusiness).toBe(true)
    }
  })

  it('blocks publishing, new subscriptions and recurring charges everywhere else', () => {
    const blocked = ALL_STATES.filter((s) => !isGuardianCleared(s))
    for (const s of blocked) {
      const c = guardianCapabilities(s)
      expect(c.canPublishPaidService).toBe(false)
      expect(c.canAcceptNewSubscriptions).toBe(false)
      expect(c.canContinueRecurringCharges).toBe(false)
    }
  })

  it('revocation stops money without touching drafts', () => {
    const c = guardianCapabilities('revoked')
    expect(c.canDraftBusiness).toBe(true)
    expect(c.canAcceptNewSubscriptions).toBe(false)
    expect(c.canContinueRecurringCharges).toBe(false)
  })
})

describe('aging out', () => {
  it('is reachable from every state that requires a guardian', () => {
    for (const s of ALL_STATES.filter((x) => x !== 'not_required')) {
      expect(transition(s, 'AGED_OUT')).toMatchObject({ to: 'not_required' })
    }
  })
})

describe('provider-facing copy', () => {
  it('says only that approval is required, per SAFETY_TRUST_POLICY section 2', () => {
    expect(PROVIDER_FACING_GUARDIAN_BLOCK).toBe('Guardian approval is required to continue.')
  })
})
