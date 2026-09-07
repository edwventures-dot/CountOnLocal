/**
 * Calendar dates, as civil dates rather than timestamps.
 *
 * These lived in domain/age.ts, which is gone with the age bands. They were
 * never really about age -- schedules, credits, reviews and subscriptions
 * all use them, and nine modules were importing "PlainDate" from a file
 * named for a concept they had nothing to do with.
 *
 * Deliberately calendar dates and not Date objects. When a visit happens is
 * a civil-calendar question; routing it through timestamps invites timezone
 * and DST bugs where a service date lands a day early or late depending on
 * where the server happens to run.
 */

export type PlainDate = { year: number; month: number; day: number }

/** Parse a YYYY-MM-DD calendar date. Rejects anything else, including timestamps. */
export function parsePlainDate(input: string): PlainDate {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input)
  if (!m) throw new RangeError('Expected a YYYY-MM-DD calendar date')
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  if (month < 1 || month > 12) throw new RangeError('Month out of range')
  if (day < 1 || day > daysInMonth(year, month)) throw new RangeError('Day out of range')
  return { year, month, day }
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** Compare two calendar dates. Negative if a precedes b. */
export function comparePlainDate(a: PlainDate, b: PlainDate): number {
  return a.year - b.year || a.month - b.month || a.day - b.day
}

/**
 * Completed years between dob and `on`. Returns a negative-safe result:
 * a DOB in the future yields -1 rather than a nonsense positive age.
 */

/** Today, as a calendar date in UTC. */
export function todayUtc(now: Date): PlainDate {
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, day: now.getUTCDate() }
}
