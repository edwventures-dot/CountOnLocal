import { describe, it, expect } from 'vitest'
import { parsePlainDate } from '../age'
import {
  toEpochDay,
  fromEpochDay,
  addDays,
  weekdayOf,
  isoDate,
  generateOccurrences,
  earliestStart,
  cycleWindow,
  type ScheduleRule,
} from '../schedule'

const d = (s: string) => parsePlainDate(s)

describe('calendar arithmetic', () => {
  it('round-trips every date across a leap year', () => {
    let cur = d('2024-01-01')
    for (let i = 0; i < 366; i += 1) {
      expect(fromEpochDay(toEpochDay(cur))).toEqual(cur)
      cur = addDays(cur, 1)
    }
  })

  it('knows the epoch was a Thursday', () => {
    expect(weekdayOf(d('1970-01-01'))).toBe('thursday')
  })

  it('crosses month, year and leap boundaries', () => {
    expect(isoDate(addDays(d('2024-02-28'), 1))).toBe('2024-02-29')
    expect(isoDate(addDays(d('2023-02-28'), 1))).toBe('2023-03-01')
    expect(isoDate(addDays(d('2024-12-31'), 1))).toBe('2025-01-01')
    expect(isoDate(addDays(d('2025-01-01'), -1))).toBe('2024-12-31')
  })

  it('agrees with a known set of weekdays', () => {
    expect(weekdayOf(d('2026-08-25'))).toBe('tuesday')
    expect(weekdayOf(d('2000-01-01'))).toBe('saturday')
    expect(weekdayOf(d('2024-02-29'))).toBe('thursday')
  })
})

const tuesdays: ScheduleRule = {
  frequency: 'weekly',
  weekdays: ['tuesday'],
  timezone: 'America/Chicago',
}

describe('weekly generation', () => {
  it('produces consecutive Tuesdays', () => {
    const dates = generateOccurrences({
      rule: tuesdays,
      start: d('2026-09-01'),
      through: d('2026-09-30'),
    })
    expect(dates.map(isoDate)).toEqual([
      '2026-09-01',
      '2026-09-08',
      '2026-09-15',
      '2026-09-22',
      '2026-09-29',
    ])
  })

  it('never emits a date before the start', () => {
    const dates = generateOccurrences({
      rule: tuesdays,
      start: d('2026-09-02'), // Wednesday, so the 1st must not appear
      through: d('2026-09-16'),
    })
    expect(dates.map(isoDate)).toEqual(['2026-09-08', '2026-09-15'])
  })

  it('honours blackout dates', () => {
    const dates = generateOccurrences({
      rule: tuesdays,
      start: d('2026-09-01'),
      through: d('2026-09-30'),
      blackoutDates: ['2026-09-08', '2026-09-22'],
    })
    expect(dates.map(isoDate)).toEqual(['2026-09-01', '2026-09-15', '2026-09-29'])
  })

  it('returns nothing when the window is inverted', () => {
    expect(
      generateOccurrences({ rule: tuesdays, start: d('2026-09-30'), through: d('2026-09-01') }),
    ).toEqual([])
  })

  it('respects the hard limit', () => {
    const dates = generateOccurrences({
      rule: tuesdays,
      start: d('2026-01-01'),
      through: d('2030-01-01'),
      limit: 5,
    })
    expect(dates).toHaveLength(5)
  })
})

describe('longer cadences anchor on the start date, not the calendar', () => {
  it('runs every two weeks from the start', () => {
    const dates = generateOccurrences({
      rule: { ...tuesdays, frequency: 'every_2_weeks' },
      start: d('2026-09-08'),
      through: d('2026-10-31'),
    })
    expect(dates.map(isoDate)).toEqual(['2026-09-08', '2026-09-22', '2026-10-06', '2026-10-20'])
  })

  it('runs every four weeks from the start', () => {
    const dates = generateOccurrences({
      rule: { ...tuesdays, frequency: 'every_4_weeks' },
      start: d('2026-09-01'),
      through: d('2026-12-31'),
    })
    expect(dates.map(isoDate)).toEqual(['2026-09-01', '2026-09-29', '2026-10-27', '2026-11-24', '2026-12-22'])
  })

  it('keeps its cadence across a year boundary', () => {
    // Anchoring on ISO week numbers instead would shift the whole schedule
    // here, because week 53 exists in some years and not others.
    const dates = generateOccurrences({
      rule: { ...tuesdays, frequency: 'every_2_weeks' },
      start: d('2026-12-15'),
      through: d('2027-02-01'),
    })
    expect(dates.map(isoDate)).toEqual(['2026-12-15', '2026-12-29', '2027-01-12', '2027-01-26'])
    for (const x of dates) expect(weekdayOf(x)).toBe('tuesday')
  })
})

describe('multiple weekdays', () => {
  it('emits every selected day within each cycle week', () => {
    const dates = generateOccurrences({
      rule: { ...tuesdays, weekdays: ['tuesday', 'friday'] },
      start: d('2026-09-01'),
      through: d('2026-09-14'),
    })
    expect(dates.map(isoDate)).toEqual(['2026-09-01', '2026-09-04', '2026-09-08', '2026-09-11'])
  })

  it('emits nothing when no weekday is selected', () => {
    expect(
      generateOccurrences({
        rule: { ...tuesdays, weekdays: [] },
        start: d('2026-09-01'),
        through: d('2026-09-30'),
      }),
    ).toEqual([])
  })
})

describe('daylight saving cannot move a route', () => {
  it('keeps every date on the scheduled weekday across a US DST change', () => {
    // US DST ends 2026-11-01. A schedule built on timestamps drifts here.
    const dates = generateOccurrences({
      rule: tuesdays,
      start: d('2026-10-20'),
      through: d('2026-11-17'),
    })
    expect(dates.map(isoDate)).toEqual([
      '2026-10-20',
      '2026-10-27',
      '2026-11-03',
      '2026-11-10',
      '2026-11-17',
    ])
    for (const x of dates) expect(weekdayOf(x)).toBe('tuesday')
  })

  it('keeps the weekday across the spring change too', () => {
    const dates = generateOccurrences({
      rule: tuesdays,
      start: d('2027-03-01'),
      through: d('2027-03-31'),
    })
    for (const x of dates) expect(weekdayOf(x)).toBe('tuesday')
  })
})

describe('earliest start', () => {
  it('never offers today, so a provider gets notice', () => {
    // 2026-09-01 is a Tuesday. With two days notice the first available
    // Tuesday is the 8th, not today.
    const first = earliestStart({ rule: tuesdays, today: d('2026-09-01'), noticeDays: 2 })
    expect(first && isoDate(first)).toBe('2026-09-08')
  })

  it('offers the next matching day when notice already clears it', () => {
    const first = earliestStart({ rule: tuesdays, today: d('2026-09-03'), noticeDays: 2 })
    expect(first && isoDate(first)).toBe('2026-09-08')
  })

  it('skips a blackout date', () => {
    const first = earliestStart({
      rule: tuesdays,
      today: d('2026-09-01'),
      noticeDays: 2,
      blackoutDates: ['2026-09-08'],
    })
    expect(first && isoDate(first)).toBe('2026-09-15')
  })
})

describe('cycle windows', () => {
  it('spans four weeks inclusive of the first day', () => {
    const w = cycleWindow(d('2026-09-01'), 4)
    expect(isoDate(w.start)).toBe('2026-09-01')
    expect(isoDate(w.end)).toBe('2026-09-28')
  })

  it('contains exactly the expected number of weekly occurrences', () => {
    const w = cycleWindow(d('2026-09-01'), 4)
    const dates = generateOccurrences({ rule: tuesdays, start: w.start, through: w.end })
    expect(dates).toHaveLength(4)
  })
})
