import { describe, expect, it } from 'vitest'
import {
  checkJurisdiction,
  isKnownTimeZone,
  normaliseRegion,
  resolveTimeZone,
  restrictedRegions,
  type JurisdictionRule,
} from '../jurisdiction'

const blockState = (region: string): JurisdictionRule => ({
  region,
  status: 'blocked',
  reason: 'Minor labour rules under review by counsel.',
})

const blockService = (region: string, catalogCode: string): JurisdictionRule => ({
  region,
  status: 'blocked',
  catalogCode,
  reason: 'This category needs a control we have not built.',
})

const allow = (region: string): JurisdictionRule => ({
  region,
  status: 'allowed',
  reason: 'Cleared by counsel 2026-08-30.',
})

describe('the open posture, which is the owner’s stated position', () => {
  const posture = 'open' as const

  it('allows a state nobody has written a rule about', () => {
    // "Not Texas-only." Operating everywhere except what counsel flags is
    // the whole point of this posture.
    expect(checkJurisdiction({ region: 'OH', rules: [], posture }).allowed).toBe(true)
  })

  it('refuses a state counsel has blocked', () => {
    const r = checkJurisdiction({ region: 'NY', rules: [blockState('NY')], posture })
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.code).toBe('STATE_BLOCKED')
  })

  it('leaves neighbouring states alone', () => {
    expect(
      checkJurisdiction({ region: 'NJ', rules: [blockState('NY')], posture }).allowed,
    ).toBe(true)
  })
})

describe('blocking one service without blocking the state', () => {
  const posture = 'open' as const
  const rules = [blockService('OH', 'dog_walking')]

  it('refuses the restricted service', () => {
    // The real question is rarely "may we operate in Ohio". It is "may a
    // fifteen-year-old be paid to walk a dog in Ohio".
    const r = checkJurisdiction({ region: 'OH', catalogCode: 'dog_walking', rules, posture })
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.code).toBe('SERVICE_BLOCKED_IN_STATE')
  })

  it('still allows every other service there', () => {
    expect(
      checkJurisdiction({ region: 'OH', catalogCode: 'trash_curb', rules, posture }).allowed,
    ).toBe(true)
  })

  it('does not block the state as a whole', () => {
    expect(checkJurisdiction({ region: 'OH', rules, posture }).allowed).toBe(true)
  })

  it('checks the service before the state, so one block is not read as both', () => {
    // Reversing the order would make a state-wide rule shadow a narrower
    // one, or a service rule refuse everything in the state.
    const mixed = [blockService('OH', 'dog_walking'), allow('OH')]
    const dog = checkJurisdiction({ region: 'OH', catalogCode: 'dog_walking', rules: mixed, posture: 'allowlist' })
    expect(dog.allowed).toBe(false)
    if (!dog.allowed) expect(dog.code).toBe('SERVICE_BLOCKED_IN_STATE')
  })
})

describe('the allowlist posture, for a staged launch', () => {
  const posture = 'allowlist' as const

  it('refuses a state nobody has cleared', () => {
    const r = checkJurisdiction({ region: 'OH', rules: [], posture })
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.code).toBe('STATE_NOT_CLEARED')
  })

  it('allows a state counsel has cleared', () => {
    expect(checkJurisdiction({ region: 'TX', rules: [allow('TX')], posture }).allowed).toBe(true)
  })

  it('still refuses a service blocked inside a cleared state', () => {
    const rules = [allow('TX'), blockService('TX', 'dog_walking')]
    expect(
      checkJurisdiction({ region: 'TX', catalogCode: 'dog_walking', rules, posture }).allowed,
    ).toBe(false)
  })

  it('tells an uncleared state the same thing a blocked one hears', () => {
    // "We have not reviewed your state yet" invites an argument support
    // cannot win, and tells a stranger about our compliance posture.
    const notCleared = checkJurisdiction({ region: 'OH', rules: [], posture })
    const blocked = checkJurisdiction({ region: 'OH', rules: [blockState('OH')], posture })
    if (!notCleared.allowed && !blocked.allowed) {
      expect(notCleared.message).toBe(blocked.message)
    }
  })
})

describe('the parts that must not be sloppy', () => {
  it('matches regions case-insensitively and ignores whitespace', () => {
    // An address form will hand this ' tx ' one day.
    const rules = [blockState('TX')]
    expect(checkJurisdiction({ region: ' tx ', rules, posture: 'open' }).allowed).toBe(false)
    expect(normaliseRegion(' tx ')).toBe('TX')
  })

  it('names the deciding rule so the refusal can be audited', () => {
    const rule = blockState('NY')
    const r = checkJurisdiction({ region: 'NY', rules: [rule], posture: 'open' })
    if (!r.allowed) expect(r.rule?.reason).toBe(rule.reason)
  })

  it('lists restricted states in a stable order', () => {
    const rules = [blockState('WY'), blockState('AK'), blockService('OH', 'dog_walking')]
    expect(restrictedRegions(rules)).toEqual(['AK', 'OH', 'WY'])
  })

  it('does not report a cleared state as restricted', () => {
    expect(restrictedRegions([allow('TX')])).toEqual([])
  })
})

describe('time zones, which were hardcoded to Central', () => {
  it('accepts a real zone', () => {
    expect(isKnownTimeZone('America/Phoenix')).toBe(true)
    expect(isKnownTimeZone('America/New_York')).toBe(true)
  })

  it('rejects junk', () => {
    // This reaches the server from a browser, so it is data, not a given.
    for (const bad of ['', 'Mars/Olympus', 'America/Chicago; drop table', 'x'.repeat(80)]) {
      expect(isKnownTimeZone(bad), bad).toBe(false)
    }
  })

  it('keeps the provider’s own zone rather than assuming Central', () => {
    // The bug this closes: every service built through the form was
    // stamped America/Chicago, so a Phoenix provider's Tuesday route was
    // promoted on Monday evening.
    expect(resolveTimeZone('America/Phoenix')).toBe('America/Phoenix')
  })

  it('falls back only when nothing usable was offered', () => {
    expect(resolveTimeZone(undefined)).toBe('America/Chicago')
    expect(resolveTimeZone('Mars/Olympus')).toBe('America/Chicago')
  })
})
