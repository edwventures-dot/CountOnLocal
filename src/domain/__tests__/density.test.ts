import { describe, expect, it } from 'vitest'
import {
  earningsPerHourCents,
  EXPANSION_UTILIZATION_THRESHOLD,
  growthPrompt,
  isReferralCode,
  MIN_CUSTOMERS_FOR_SOCIAL_PROOF,
  normalizeReferralCode,
  referralCodeFrom,
  REFERRAL_CODE_LENGTH,
  routeDensity,
  socialProof,
} from '../density'

describe('routeDensity', () => {
  it('measures a half-full route', () => {
    const d = routeDensity({ activeCustomers: 9, capacity: 18 })
    expect(d.utilization).toBe(0.5)
    expect(d.openSpots).toBe(9)
  })

  it('treats an over-full route as full, not 120% full', () => {
    const d = routeDensity({ activeCustomers: 24, capacity: 20 })
    expect(d.utilization).toBe(1)
    expect(d.openSpots).toBe(0)
  })

  it('does not divide by an unset capacity', () => {
    const d = routeDensity({ activeCustomers: 3, capacity: 0 })
    expect(d.utilization).toBe(0)
    expect(d.openSpots).toBe(0)
  })

  it('ignores nonsense input rather than propagating it', () => {
    const d = routeDensity({ activeCustomers: -5, capacity: 10 })
    expect(d.activeCustomers).toBe(0)
  })
})

describe('the prompt tells providers to fill before widening', () => {
  it('says fill the route on a half-full one', () => {
    const p = growthPrompt({
      density: routeDensity({ activeCustomers: 8, capacity: 18 }),
      areaLabel: 'Oak Ridge',
    })
    expect(p.code).toBe('fill_the_route')
    expect(p.headline).toContain('8 homes in Oak Ridge')
    expect(p.headline).toContain('10 spots open')
  })

  it('does not suggest expanding below the threshold', () => {
    // The failure this whole system is shaped to avoid: more walking for
    // the same money.
    for (const active of [1, 5, 10, 14]) {
      const p = growthPrompt({ density: routeDensity({ activeCustomers: active, capacity: 18 }) })
      expect(p.code).not.toBe('consider_expanding')
      expect(p.action).not.toBe('expand_area')
    }
  })

  it('suggests expanding only when nearly full', () => {
    const p = growthPrompt({ density: routeDensity({ activeCustomers: 16, capacity: 18 }) })
    expect(p.code).toBe('consider_expanding')
  })

  it('has a high threshold on purpose', () => {
    expect(EXPANSION_UTILIZATION_THRESHOLD).toBeGreaterThanOrEqual(0.8)
  })

  it('says the route is full at capacity', () => {
    const p = growthPrompt({ density: routeDensity({ activeCustomers: 18, capacity: 18 }) })
    expect(p.code).toBe('nearly_full')
    expect(p.action).toBe('expand_area')
  })

  it('asks for capacity before anything else', () => {
    const p = growthPrompt({ density: routeDensity({ activeCustomers: 5, capacity: 0 }) })
    expect(p.code).toBe('no_capacity_set')
  })

  it('sends a provider with no customers to share, not to a flyer run', () => {
    const p = growthPrompt({ density: routeDensity({ activeCustomers: 0, capacity: 18 }) })
    expect(p.code).toBe('get_first_customer')
    expect(p.action).toBe('share')
  })

  it('gets the singular right', () => {
    const p = growthPrompt({ density: routeDensity({ activeCustomers: 1, capacity: 2 }) })
    expect(p.headline).toContain('1 home')
    expect(p.headline).not.toContain('1 homes')
    expect(p.headline).toContain('1 spot open')
  })

  it('never puts an address in a prompt', () => {
    const p = growthPrompt({
      density: routeDensity({ activeCustomers: 8, capacity: 18 }),
      areaLabel: 'Oak Ridge',
    })
    // areaLabel is the public neighbourhood label, never a street.
    expect(JSON.stringify(p)).not.toMatch(/\d+\s+\w+\s+(St|Street|Ave|Road)/i)
  })
})

describe('social proof is a privacy threshold', () => {
  it('says nothing at all with two customers', () => {
    const p = socialProof({ activeCustomers: 2, areaLabel: 'Oak Ridge' })
    expect(p.show).toBe(false)
    // Not a hedge either. "A few homes" is still a claim about a number.
    expect(JSON.stringify(p)).not.toMatch(/few|some|popular/i)
  })

  it.each([0, 1, 2, 3, 4])('stays silent at %i customers', (n) => {
    expect(socialProof({ activeCustomers: n }).show).toBe(false)
  })

  it('speaks at the threshold', () => {
    const p = socialProof({ activeCustomers: 5, areaLabel: 'Oak Ridge' })
    expect(p.show).toBe(true)
    if (p.show) expect(p.label).toBe('Serving 5 homes in Oak Ridge')
  })

  it('falls back to a vague place when there is no label', () => {
    const p = socialProof({ activeCustomers: 8 })
    if (p.show) expect(p.label).toBe('Serving 8 homes in this area')
  })

  it('never names a house', () => {
    const p = socialProof({ activeCustomers: 8, areaLabel: 'Oak Ridge' })
    if (p.show) expect(p.label).not.toMatch(/\d+\s+\w+\s+(St|Street|Ave)/i)
  })

  it('uses a threshold above one, which is what makes it a threshold', () => {
    expect(MIN_CUSTOMERS_FOR_SOCIAL_PROOF).toBeGreaterThan(1)
  })

  it('honours a market-specific minimum', () => {
    expect(socialProof({ activeCustomers: 3, minimum: 3 }).show).toBe(true)
  })
})

describe('earnings per hour', () => {
  it('scales a route to an hour', () => {
    // $54 over 90 minutes is $36/hour.
    expect(earningsPerHourCents({ routeValueCents: 5400, estimatedMinutes: 90 })).toBe(3600)
  })

  it('returns nothing rather than inventing a number', () => {
    expect(earningsPerHourCents({ routeValueCents: 5400, estimatedMinutes: 0 })).toBeNull()
    expect(earningsPerHourCents({ routeValueCents: 0, estimatedMinutes: -5 })).toBeNull()
  })
})

describe('referral codes', () => {
  const bytes = (n: number) => new Uint8Array(Array.from({ length: n }, (_, i) => i * 7 + 3))

  it('is the documented length', () => {
    expect(referralCodeFrom(bytes(16))).toHaveLength(REFERRAL_CODE_LENGTH)
  })

  it('avoids characters that get misread off a flyer', () => {
    // Sampling every byte value covers the whole alphabet.
    for (let i = 0; i < 256; i += 1) {
      const code = referralCodeFrom(new Uint8Array(REFERRAL_CODE_LENGTH).fill(i))
      expect(code).not.toMatch(/[01OIL]/)
    }
  })

  it('is deterministic for the same bytes', () => {
    expect(referralCodeFrom(bytes(16))).toBe(referralCodeFrom(bytes(16)))
  })

  it('refuses to build one from too little randomness', () => {
    expect(() => referralCodeFrom(new Uint8Array(4))).toThrow(RangeError)
  })

  it('recognises a valid code', () => {
    expect(isReferralCode(referralCodeFrom(bytes(16)))).toBe(true)
  })

  it('rejects the wrong length or an excluded character', () => {
    expect(isReferralCode('ABC')).toBe(false)
    expect(isReferralCode('ABCDEFG0')).toBe(false) // zero is not in the alphabet
    expect(isReferralCode(null)).toBe(false)
  })
})

describe('normalising what somebody typed', () => {
  it('uppercases', () => {
    const code = referralCodeFrom(new Uint8Array(REFERRAL_CODE_LENGTH).fill(5))
    expect(normalizeReferralCode(code.toLowerCase())).toBe(code)
  })

  it('drops spaces and dashes people add for readability', () => {
    expect(normalizeReferralCode('ABCD-EFGH')).toBe('ABCDEFGH')
    expect(normalizeReferralCode(' ABCD EFGH ')).toBe('ABCDEFGH')
  })

  it('drops characters the alphabet excludes rather than guessing', () => {
    // A typed O is a misreading of something else; guessing which would be
    // worse than failing the lookup honestly.
    expect(normalizeReferralCode('AOBOCODO')).toBe('ABCD')
  })

  it('does not run past the code length', () => {
    expect(normalizeReferralCode('ABCDEFGHJKMN')).toHaveLength(REFERRAL_CODE_LENGTH)
  })

  it('returns empty for input with nothing usable in it', () => {
    expect(normalizeReferralCode('!!! 011 !!!')).toBe('')
  })
})
