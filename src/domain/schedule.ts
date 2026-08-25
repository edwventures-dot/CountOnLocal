/**
 * Recurring schedules and occurrence generation.
 *
 * TECHNICAL_SPEC section 8: weekly, every two weeks, every four weeks,
 * selected weekdays, a service window, blackout dates, and a rolling
 * horizon rather than years of rows generated up front.
 *
 * Everything here is calendar-date arithmetic. Not a single Date object is
 * constructed from a timestamp, because "the Tuesday route" is a civil
 * calendar fact and routing it through UTC offsets is how a route silently
 * moves to Monday twice a year.
 */

import type { PlainDate } from './age'
import { comparePlainDate, daysInMonth } from './age'

export type Weekday = 'sunday' | 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday'

export const WEEKDAYS: readonly Weekday[] = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
]

export type Frequency = 'weekly' | 'every_2_weeks' | 'every_4_weeks'

export type ScheduleRule = {
  frequency: Frequency
  /** Days of the week this service runs. At least one. */
  weekdays: readonly Weekday[]
  /** Local service window, e.g. "08:00" to "18:00". Display and routing only. */
  windowStart?: string
  windowEnd?: string
  /** IANA zone. Stored so a local date can be rendered correctly anywhere. */
  timezone: string
}

export const WEEKS_BETWEEN: Readonly<Record<Frequency, number>> = {
  weekly: 1,
  every_2_weeks: 2,
  every_4_weeks: 4,
}

/** Days since 1970-01-01 for a calendar date. Pure integer arithmetic. */
export function toEpochDay(d: PlainDate): number {
  // Howard Hinnant's civil-from-days, inverted. Correct for all Gregorian
  // dates and free of any timezone involvement.
  const y = d.month <= 2 ? d.year - 1 : d.year
  const era = Math.floor(y / 400)
  const yoe = y - era * 400
  const mp = (d.month + 9) % 12
  const doy = Math.floor((153 * mp + 2) / 5) + d.day - 1
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
  return era * 146097 + doe - 719468
}

export function fromEpochDay(days: number): PlainDate {
  const z = days + 719468
  const era = Math.floor(z / 146097)
  const doe = z - era * 146097
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365)
  const y = yoe + era * 400
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp = Math.floor((5 * doy + 2) / 153)
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1
  const month = mp < 10 ? mp + 3 : mp - 9
  return { year: month <= 2 ? y + 1 : y, month, day }
}

export function addDays(d: PlainDate, n: number): PlainDate {
  return fromEpochDay(toEpochDay(d) + n)
}

/** 0 = Sunday. */
export function dayOfWeek(d: PlainDate): number {
  // 1970-01-01 was a Thursday (4).
  const n = (toEpochDay(d) + 4) % 7
  return n < 0 ? n + 7 : n
}

export function weekdayOf(d: PlainDate): Weekday {
  return WEEKDAYS[dayOfWeek(d)]!
}

export function isoDate(d: PlainDate): string {
  const mm = String(d.month).padStart(2, '0')
  const dd = String(d.day).padStart(2, '0')
  return `${d.year}-${mm}-${dd}`
}

export type GenerateArgs = {
  rule: ScheduleRule
  /** First date the service may run. Usually the agreed start date. */
  start: PlainDate
  /** Generate up to and including this date. */
  through: PlainDate
  /** Dates the provider is unavailable, as ISO strings. */
  blackoutDates?: readonly string[]
  /** Hard cap, so a bad rule cannot generate an unbounded list. */
  limit?: number
}

/**
 * Every service date in the window.
 *
 * The cadence anchors on `start`, not on the calendar: an every-2-weeks
 * service beginning on the 8th runs on the 8th and the 22nd, regardless of
 * which ISO week those fall in. Anchoring on week numbers instead would
 * shift the whole schedule at a year boundary.
 */
export function generateOccurrences(args: GenerateArgs): PlainDate[] {
  const { rule, start, through } = args
  const blackout = new Set(args.blackoutDates ?? [])
  const limit = args.limit ?? 400

  if (rule.weekdays.length === 0) return []
  if (comparePlainDate(start, through) > 0) return []

  const wanted = new Set(rule.weekdays)
  const strideDays = WEEKS_BETWEEN[rule.frequency] * 7

  // The cycle anchor is the Sunday of the week containing `start`, so every
  // selected weekday within a cycle week is included even if `start` falls
  // mid-week.
  const anchor = addDays(start, -dayOfWeek(start))

  const out: PlainDate[] = []
  const throughEpoch = toEpochDay(through)
  const startEpoch = toEpochDay(start)

  for (let cursor = toEpochDay(anchor); cursor <= throughEpoch; cursor += strideDays) {
    for (let offset = 0; offset < 7; offset += 1) {
      const epoch = cursor + offset
      if (epoch < startEpoch || epoch > throughEpoch) continue
      const date = fromEpochDay(epoch)
      if (!wanted.has(weekdayOf(date))) continue
      if (blackout.has(isoDate(date))) continue
      out.push(date)
      if (out.length >= limit) return out
    }
  }

  return out
}

/**
 * The earliest date a new customer can start.
 *
 * A provider needs notice before a stranger appears on their route, so the
 * first service is never today. `noticeDays` is the provider's configured
 * lead time.
 */
export function earliestStart(args: {
  rule: ScheduleRule
  today: PlainDate
  noticeDays: number
  blackoutDates?: readonly string[]
}): PlainDate | null {
  const from = addDays(args.today, Math.max(0, args.noticeDays))
  const dates = generateOccurrences({
    rule: args.rule,
    start: from,
    through: addDays(from, 90),
    ...(args.blackoutDates ? { blackoutDates: args.blackoutDates } : {}),
    limit: 1,
  })
  return dates[0] ?? null
}

/** The cycle a start date opens: [start, start + cycleWeeks) in calendar days. */
export function cycleWindow(start: PlainDate, cycleWeeks: number): { start: PlainDate; end: PlainDate } {
  return { start, end: addDays(start, cycleWeeks * 7 - 1) }
}

export { daysInMonth }
