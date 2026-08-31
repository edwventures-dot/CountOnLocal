import { describe, expect, it } from 'vitest'
import { differsMaterially, parseNormalisedAddress } from '../normalisedAddress'

describe('reading the geocoder back into fields', () => {
  it('parses the shape the Census returns', () => {
    expect(parseNormalisedAddress('1102 CONGRESS AVE, AUSTIN, TX, 78701')).toEqual({
      line1: '1102 CONGRESS AVE',
      city: 'AUSTIN',
      region: 'TX',
      postalCode: '78701',
    })
  })

  it('accepts a ZIP+4', () => {
    expect(parseNormalisedAddress('1 MAIN ST, AUSTIN, TX, 78701-1234')?.postalCode).toBe(
      '78701-1234',
    )
  })

  it('refuses anything it does not recognise, rather than guessing', () => {
    // A half-parse puts a city name in a postcode column, which is worse
    // than not parsing: the caller falls back to what was typed, which is
    // exactly the behaviour this replaced.
    for (const junk of [
      '',
      'AUSTIN, TX',
      '1 MAIN ST, AUSTIN, TEXAS, 78701',
      '1 MAIN ST, AUSTIN, TX, AUSTIN',
      '1 MAIN ST, AUSTIN, TX, 78701, EXTRA',
      'some free text with no commas',
    ]) {
      expect(parseNormalisedAddress(junk), junk).toBeNull()
    }
  })

  it('refuses null and undefined', () => {
    expect(parseNormalisedAddress(null)).toBeNull()
    expect(parseNormalisedAddress(undefined)).toBeNull()
  })
})

describe('deciding whether the correction is worth noticing', () => {
  const parsed = {
    line1: '1100 CONGRESS AVE',
    city: 'AUSTIN',
    region: 'TX',
    postalCode: '78701',
  }

  it('ignores case and spacing', () => {
    expect(
      differsMaterially(
        { line1: '1100 congress  ave', city: 'austin', region: 'TX', postalCode: '78701' },
        parsed,
      ),
    ).toBe(false)
  })

  it('ignores a trailing full stop somebody typed over a prefilled field', () => {
    expect(
      differsMaterially(
        { line1: '1100 Congress Ave.', city: 'Austin', region: 'TX', postalCode: '78701' },
        parsed,
      ),
    ).toBe(false)
  })

  it('notices a ZIP in a different city', () => {
    // The case this was written for: 77429 is Cypress, 165 miles from the
    // Austin address it was typed against.
    expect(
      differsMaterially(
        { line1: '1100 Congress Ave', city: 'Austin', region: 'TX', postalCode: '77429' },
        parsed,
      ),
    ).toBe(true)
  })

  it('notices a different street', () => {
    expect(
      differsMaterially(
        { line1: '1102 Congress Ave', city: 'Austin', region: 'TX', postalCode: '78701' },
        parsed,
      ),
    ).toBe(true)
  })

  it('compares only the first five digits of a ZIP+4', () => {
    expect(
      differsMaterially(
        { line1: '1100 Congress Ave', city: 'Austin', region: 'TX', postalCode: '78701-9999' },
        parsed,
      ),
    ).toBe(false)
  })
})
