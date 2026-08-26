import { describe, expect, it } from 'vitest'
import {
  normalizeEmail,
  validateWaitlistSignup,
  isWaitlistRole,
  WAITLIST_ROLES,
} from '../waitlist'

describe('normalizeEmail', () => {
  it('trims and lowercases so the same person cannot enrol twice', () => {
    expect(normalizeEmail('  Jake@Example.COM ')).toBe('jake@example.com')
  })
})

describe('isWaitlistRole', () => {
  it('accepts the three audiences the product actually has', () => {
    for (const r of WAITLIST_ROLES) expect(isWaitlistRole(r)).toBe(true)
  })

  it('rejects anything else, including near-misses', () => {
    for (const bad of ['admin', 'parent', 'Provider', '', null, 7, undefined]) {
      expect(isWaitlistRole(bad)).toBe(false)
    }
  })
})

describe('validateWaitlistSignup', () => {
  it('accepts a complete signup and normalises it', () => {
    const r = validateWaitlistSignup({
      email: ' Jake@Example.com ',
      role: 'provider',
      postalCode: ' 84043 ',
    })
    expect(r).toEqual({
      ok: true,
      value: { email: 'jake@example.com', role: 'provider', postalCode: '84043' },
    })
  })

  it('treats postal code as optional', () => {
    const r = validateWaitlistSignup({ email: 'a@b.co', role: 'customer', postalCode: '' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.postalCode).toBeNull()
  })

  it('keeps only the first five digits of ZIP+4', () => {
    const r = validateWaitlistSignup({ email: 'a@b.co', role: 'guardian', postalCode: '84043-1234' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.postalCode).toBe('84043')
  })

  it('reports every problem at once rather than one at a time', () => {
    const r = validateWaitlistSignup({ email: 'nope', role: 'mayor', postalCode: 'abc' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(Object.keys(r.fieldErrors).sort()).toEqual(['email', 'postalCode', 'role'])
    }
  })

  it.each([
    ['missing @', 'jakeexample.com'],
    ['no domain dot', 'jake@example'],
    ['spaces', 'ja ke@example.com'],
    ['empty', ''],
  ])('rejects a malformed email (%s)', (_label, email) => {
    const r = validateWaitlistSignup({ email, role: 'provider' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.fieldErrors.email).toBeTruthy()
  })

  it('rejects an over-long email rather than truncating it', () => {
    const email = 'a'.repeat(250) + '@example.com'
    const r = validateWaitlistSignup({ email, role: 'provider' })
    expect(r.ok).toBe(false)
  })

  it('does not accept a date of birth even if one is sent', () => {
    // A waitlist grants nothing, so it has no business holding a minor's DOB.
    const r = validateWaitlistSignup({
      email: 'a@b.co',
      role: 'provider',
      // @ts-expect-error deliberately passing a field the type does not allow
      dateOfBirth: '2011-04-02',
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(Object.keys(r.value).sort()).toEqual(['email', 'postalCode', 'role'])
  })
})
