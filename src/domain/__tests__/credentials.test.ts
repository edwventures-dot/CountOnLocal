import { describe, expect, it } from 'vitest'
import {
  checkEmail,
  checkPassword,
  checkSignupCredentials,
  DEFAULT_LANDING,
  interpretSignupError,
  normalizeEmail,
  PASSWORD_MIN_LENGTH,
  safeNextPath,
  SIGNUP_CONFIRMATION_NOTICE,
} from '../credentials'

describe('email', () => {
  it('accepts an ordinary address', () => {
    expect(checkEmail('jordan@example.com').ok).toBe(true)
  })

  it('accepts the addresses a regular expression usually breaks', () => {
    // Every attempt to decide deliverability with a pattern rejects
    // somebody's real address. These are all valid.
    for (const address of [
      'jordan+bins@example.com',
      "o'brien@example.co.uk",
      'j.o.r.d.a.n@example.museum',
      'jordan_2011@sub.domain.example.org',
      'x@y.dev',
    ]) {
      expect(checkEmail(address), address).toEqual({ ok: true })
    }
  })

  it('refuses something that is not an address', () => {
    for (const bad of ['', 'jordan', 'jordan@', '@example.com', 'jordan@example', 'a b@c.com']) {
      expect(checkEmail(bad).ok, bad).toBe(false)
    }
  })

  it('refuses two at signs', () => {
    expect(checkEmail('a@b@example.com').ok).toBe(false)
  })

  it('refuses a domain with a trailing or leading dot', () => {
    expect(checkEmail('jordan@example.com.').ok).toBe(false)
    expect(checkEmail('jordan@.example.com').ok).toBe(false)
  })

  it('normalises case and surrounding space', () => {
    expect(normalizeEmail('  Jordan@Example.COM ')).toBe('jordan@example.com')
  })

  it('accepts an address that only becomes valid after trimming', () => {
    expect(checkEmail('  jordan@example.com  ').ok).toBe(true)
  })
})

describe('password', () => {
  it('accepts a passphrase', () => {
    expect(checkPassword('correct horse battery').ok).toBe(true)
  })

  it('has no composition rules', () => {
    // No "must contain a symbol". Composition rules produce Password1! and
    // then reuse of it everywhere, and punish the long passphrase that is
    // actually strong.
    expect(checkPassword('all lower case words here').ok).toBe(true)
    expect(checkPassword('0000000000000000000000').ok).toBe(true)
  })

  it('enforces the floor', () => {
    expect(checkPassword('a'.repeat(PASSWORD_MIN_LENGTH)).ok).toBe(true)
    expect(checkPassword('a'.repeat(PASSWORD_MIN_LENGTH - 1)).ok).toBe(false)
  })

  it('is stricter than the six characters Supabase would allow', () => {
    expect(PASSWORD_MIN_LENGTH).toBeGreaterThan(6)
    expect(checkPassword('abc123').ok).toBe(false)
  })

  it('says how long, not just that it is wrong', () => {
    const r = checkPassword('short')
    if (!r.ok) expect(r.message).toContain(String(PASSWORD_MIN_LENGTH))
  })

  it('refuses the ones guessed first, long enough or not', () => {
    expect(checkPassword('password123').ok).toBe(false)
    expect(checkPassword('PassWord123').ok).toBe(false)
    expect(checkPassword('countonlocal').ok).toBe(false)
  })

  it('refuses a password built from the email name', () => {
    // The single most common weak choice, and the first thing tried by
    // somebody who already knows the address.
    expect(checkPassword('jordan-jordan-jordan', 'jordan@example.com').ok).toBe(false)
    expect(checkPassword('myJORDANpassword', 'jordan@example.com').ok).toBe(false)
  })

  it('does not refuse a short local part that appears by chance', () => {
    // Three characters turn up inside ordinary words.
    expect(checkPassword('the quick brown fox', 'joe@example.com').ok).toBe(true)
  })

  it('checks the email name only when an email is given', () => {
    expect(checkPassword('jordan-jordan-jordan').ok).toBe(true)
  })

  it('refuses one longer than the processor accepts', () => {
    expect(checkPassword('a'.repeat(73)).ok).toBe(false)
  })

  it('accepts exactly the maximum', () => {
    expect(checkPassword('a'.repeat(72)).ok).toBe(true)
  })
})

describe('both together', () => {
  it('reports the email problem first, so the message names the field to fix', () => {
    const r = checkSignupCredentials({ email: 'nope', password: 'short' })
    if (!r.ok) expect(r.message).toMatch(/email/i)
  })

  it('passes a good pair', () => {
    expect(
      checkSignupCredentials({ email: 'jordan@example.com', password: 'a decent passphrase' }),
    ).toEqual({ ok: true })
  })
})

describe('sign-up does not reveal whether an address is taken', () => {
  it('answers an existing account with the confirmation notice', () => {
    // The same sentence a brand new address gets. That is the point.
    const r = interpretSignupError('User already registered')
    expect(r).toEqual({ kind: 'confirm', message: SIGNUP_CONFIRMATION_NOTICE })
  })

  it('never echoes the processor wording', () => {
    for (const raw of [
      'User already registered',
      'A user with this email address has already been registered',
      'Email address "x@y.com" is invalid',
      'Signup requires a valid password',
      'Some future error nobody has seen',
    ]) {
      expect(interpretSignupError(raw).message, raw).not.toContain(raw)
    }
  })

  it('does not leak an address that was echoed back at us', () => {
    const r = interpretSignupError('Email address "jordan@example.com" is invalid')
    expect(r.message).not.toContain('jordan@example.com')
  })

  it('still helps with the problems that are the person own to fix', () => {
    expect(interpretSignupError('Password should be at least 6 characters').kind).toBe('retry')
    expect(interpretSignupError('email rate limit exceeded').message).toMatch(/wait/i)
  })

  it('falls back to something generic rather than passing through', () => {
    expect(interpretSignupError('unheard of failure').message).toBe(
      'We could not create that account. Please try again.',
    )
  })
})

describe('the post-sign-in redirect cannot leave the site', () => {
  it('keeps an ordinary path', () => {
    expect(safeNextPath('/guardian/invitations/tok_abc')).toBe('/guardian/invitations/tok_abc')
  })

  it('falls back when there is nothing', () => {
    expect(safeNextPath(null)).toBe(DEFAULT_LANDING)
    expect(safeNextPath('')).toBe(DEFAULT_LANDING)
    expect(safeNextPath('   ')).toBe(DEFAULT_LANDING)
  })

  it('refuses an absolute url', () => {
    expect(safeNextPath('https://evil.example/steal')).toBe(DEFAULT_LANDING)
    expect(safeNextPath('http://evil.example')).toBe(DEFAULT_LANDING)
  })

  it('refuses a protocol-relative url, which is the one people forget', () => {
    // A browser reads // as protocol-relative and leaves the site, even
    // though it starts with a slash.
    expect(safeNextPath('//evil.example/steal')).toBe(DEFAULT_LANDING)
    expect(safeNextPath('/\\evil.example')).toBe(DEFAULT_LANDING)
  })

  it('refuses a javascript url', () => {
    expect(safeNextPath('javascript:alert(1)')).toBe(DEFAULT_LANDING)
  })

  it('refuses control characters used to confuse a url parser', () => {
    expect(safeNextPath('/\u0000//evil.example')).toBe(DEFAULT_LANDING)
    expect(safeNextPath('/\n//evil.example')).toBe(DEFAULT_LANDING)
  })
})
