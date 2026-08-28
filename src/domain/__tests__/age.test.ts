import { describe, it, expect } from 'vitest'
import { parsePlainDate, ageInYearsOn, classifyAge, decideProviderAge, isEligibleCustomerAge, eighteenthBirthday, daysUntilEighteen, hasAgedOut } from '../age'

const on = (s: string) => parsePlainDate(s)

describe('parsePlainDate', () => {
  it('accepts a calendar date', () => {
    expect(parsePlainDate('2010-02-28')).toEqual({ year: 2010, month: 2, day: 28 })
  })

  it('accepts Feb 29 in a leap year and rejects it otherwise', () => {
    expect(parsePlainDate('2024-02-29').day).toBe(29)
    expect(() => parsePlainDate('2023-02-29')).toThrow(RangeError)
  })

  it('rejects timestamps and malformed input', () => {
    for (const bad of ['2010-02-28T00:00:00Z', '2010-2-8', '02/28/2010', '2010-13-01', '']) {
      expect(() => parsePlainDate(bad)).toThrow(RangeError)
    }
  })
})

describe('ageInYearsOn', () => {
  it('turns over exactly on the birthday, not before', () => {
    const dob = on('2012-06-15')
    expect(ageInYearsOn(dob, on('2030-06-14'))).toBe(17)
    expect(ageInYearsOn(dob, on('2030-06-15'))).toBe(18)
    expect(ageInYearsOn(dob, on('2030-06-16'))).toBe(18)
  })

  it('handles a leap-day birthday without drifting', () => {
    const dob = on('2012-02-29')
    expect(ageInYearsOn(dob, on('2025-02-28'))).toBe(12)
    expect(ageInYearsOn(dob, on('2025-03-01'))).toBe(13)
  })

  it('does not invent a positive age for a future date of birth', () => {
    expect(ageInYearsOn(on('2030-01-01'), on('2026-01-01'))).toBe(-1)
  })
})

describe('provider age gate - QA_ACCEPTANCE section 2', () => {
  const today = on('2026-08-24')

  it('blocks a 12-year-old', () => {
    const d = decideProviderAge(on('2013-08-25'), today) // 12, birthday tomorrow
    expect(d.allowed).toBe(false)
  })

  it('admits a provider on their 13th birthday, guardian required', () => {
    const d = decideProviderAge(on('2013-08-24'), today)
    expect(d).toEqual({ allowed: true, band: 'minor', guardianRequired: true })
  })

  it('still requires a guardian the day before turning 18', () => {
    const d = decideProviderAge(on('2008-08-25'), today) // 17
    expect(d).toEqual({ allowed: true, band: 'minor', guardianRequired: true })
  })

  it('drops the guardian requirement on the 18th birthday', () => {
    const d = decideProviderAge(on('2008-08-24'), today)
    expect(d).toEqual({ allowed: true, band: 'adult', guardianRequired: false })
  })

  it('rejects with a neutral code that does not leak the qualifying age', () => {
    const d = decideProviderAge(on('2020-01-01'), today)
    expect(d.allowed).toBe(false)
    // The whole payload is inspected: nothing in it hints at what DOB would
    // have worked, which would amount to coaching the applicant to lie.
    const serialized = JSON.stringify(d)
    expect(serialized).toBe('{"allowed":false,"code":"PROVIDER_INELIGIBLE"}')
    expect(serialized).not.toMatch(/13|18|age|year/i)
  })

  it('rejects a future date of birth rather than treating it as adult', () => {
    expect(decideProviderAge(on('2040-01-01'), today).allowed).toBe(false)
  })
})

describe('classifyAge boundaries', () => {
  const today = on('2026-08-24')
  it('maps each band', () => {
    expect(classifyAge(on('2014-08-24'), today)).toBe('under_min_age') // 12
    expect(classifyAge(on('2013-08-24'), today)).toBe('minor') // 13
    expect(classifyAge(on('2008-08-25'), today)).toBe('minor') // 17
    expect(classifyAge(on('2008-08-24'), today)).toBe('adult') // 18
  })
})

describe('customer age - PRD section 6 requires 18+', () => {
  const today = on('2026-08-24')
  it('admits 18 and rejects 17', () => {
    expect(isEligibleCustomerAge(on('2008-08-24'), today)).toBe(true)
    expect(isEligibleCustomerAge(on('2008-08-25'), today)).toBe(false)
  })
})

describe('turning eighteen', () => {
  const d = (year: number, month: number, day: number) => ({ year, month, day })

  it('is the same date eighteen years later', () => {
    expect(eighteenthBirthday(d(2008, 6, 15))).toEqual(d(2026, 6, 15))
  })

  it('moves a 29 February birthday to 1 March in a non-leap year', () => {
    // 2008 + 18 = 2026, which is not a leap year. Somebody born on the
    // 29th does not get to stay seventeen for an extra year.
    expect(eighteenthBirthday(d(2008, 2, 29))).toEqual(d(2026, 3, 1))
  })

  it('keeps 29 February when the target year is a leap year', () => {
    // 2006 + 18 = 2024, which is.
    expect(eighteenthBirthday(d(2006, 2, 29))).toEqual(d(2024, 2, 29))
  })

  it('counts down to it', () => {
    expect(daysUntilEighteen(d(2008, 6, 15), d(2026, 6, 14))).toBe(1)
    expect(daysUntilEighteen(d(2008, 6, 15), d(2026, 5, 16))).toBe(30)
  })

  it('goes negative afterwards', () => {
    expect(daysUntilEighteen(d(2008, 6, 15), d(2026, 6, 16))).toBe(-1)
  })

  it('ages out on the birthday, not the day after', () => {
    expect(hasAgedOut(d(2008, 6, 15), d(2026, 6, 14))).toBe(false)
    expect(hasAgedOut(d(2008, 6, 15), d(2026, 6, 15))).toBe(true)
  })

  it('agrees with classifyAge, so the gates and the job cannot disagree', () => {
    // The job that clears guardian state and the gates that read it must
    // use one definition of how old somebody is.
    for (const [dob, today] of [
      [d(2008, 6, 15), d(2026, 6, 14)],
      [d(2008, 6, 15), d(2026, 6, 15)],
      [d(2011, 1, 1), d(2026, 8, 28)],
    ] as const) {
      expect(hasAgedOut(dob, today)).toBe(classifyAge(dob, today) === 'adult')
    }
  })
})
