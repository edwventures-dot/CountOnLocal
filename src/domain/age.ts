/**
 * Age policy.
 *
 * PRD section 6 and SAFETY_TRUST_POLICY section 1:
 *   - under 13            registration blocked outright
 *   - 13 to 17            may draft, but a verified guardian is required
 *                         before paid customers can be accepted
 *   - 18 and over         independent
 *   - customers           18+ in V1
 *
 * TECHNICAL_SPEC section 4: date of birth is private and authoritative.
 * A derived age band may be cached, but age is always recomputed from the
 * stored DOB and the current date -- never trusted from the client, and
 * never frozen at signup (a provider who turns 18 must stop being a minor
 * without anyone running a migration).
 *
 * Dates here are deliberately calendar dates, not timestamps. Age is a
 * civil-calendar question; routing it through Date objects invites
 * timezone and DST bugs where a birthday lands a day early or late
 * depending on where the server happens to run.
 */

export const PROVIDER_MIN_AGE = 13
export const GUARDIAN_REQUIRED_BELOW_AGE = 18
export const CUSTOMER_MIN_AGE = 18

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
export function ageInYearsOn(dob: PlainDate, on: PlainDate): number {
  if (comparePlainDate(dob, on) > 0) return -1
  let age = on.year - dob.year
  // birthday has not yet occurred this year
  if (on.month < dob.month || (on.month === dob.month && on.day < dob.day)) age -= 1
  return age
}

export type AgeBand = 'under_min_age' | 'minor' | 'adult'

export function classifyAge(dob: PlainDate, on: PlainDate): AgeBand {
  const age = ageInYearsOn(dob, on)
  if (age < PROVIDER_MIN_AGE) return 'under_min_age'
  if (age < GUARDIAN_REQUIRED_BELOW_AGE) return 'minor'
  return 'adult'
}

export type ProviderAgeDecision =
  | { allowed: false; code: 'PROVIDER_INELIGIBLE' }
  | { allowed: true; band: 'minor' | 'adult'; guardianRequired: boolean }

/**
 * Gate for provider registration.
 *
 * QA_ACCEPTANCE section 2 requires the rejection to be neutral: it must not
 * tell the applicant what age would have worked, because that is an
 * instruction to come back with a false DOB. So there is one opaque code
 * for every rejection and no age echoed back.
 */
export function decideProviderAge(dob: PlainDate, on: PlainDate): ProviderAgeDecision {
  const band = classifyAge(dob, on)
  if (band === 'under_min_age') return { allowed: false, code: 'PROVIDER_INELIGIBLE' }
  return { allowed: true, band, guardianRequired: band === 'minor' }
}

export function isEligibleCustomerAge(dob: PlainDate, on: PlainDate): boolean {
  return ageInYearsOn(dob, on) >= CUSTOMER_MIN_AGE
}

/**
 * The day somebody stops needing a guardian.
 *
 * Returned as a civil date rather than an instant, for the same reason
 * service dates are: a birthday is a day where the person lives, not a
 * moment in UTC. Somebody born on 29 February ages out on 1 March in
 * non-leap years, which is the convention every jurisdiction that has
 * bothered to write it down uses.
 */
export function eighteenthBirthday(dob: PlainDate): PlainDate {
  const year = dob.year + GUARDIAN_REQUIRED_BELOW_AGE

  if (dob.month === 2 && dob.day === 29 && daysInMonth(year, 2) === 28) {
    return { year, month: 3, day: 1 }
  }
  return { year, month: dob.month, day: dob.day }
}

/** Whole days until that birthday. Negative once it has passed. */
export function daysUntilEighteen(dob: PlainDate, today: PlainDate): number {
  const target = eighteenthBirthday(dob)
  const toUtc = (d: PlainDate) => Date.UTC(d.year, d.month - 1, d.day)
  return Math.round((toUtc(target) - toUtc(today)) / 86_400_000)
}

/**
 * Whether this provider should no longer be treated as a minor.
 *
 * Uses the same age arithmetic as every other check rather than comparing
 * dates directly, so there is exactly one definition of how old somebody
 * is and the gates cannot disagree with the job that clears them.
 */
export function hasAgedOut(dob: PlainDate, today: PlainDate): boolean {
  return ageInYearsOn(dob, today) >= GUARDIAN_REQUIRED_BELOW_AGE
}
