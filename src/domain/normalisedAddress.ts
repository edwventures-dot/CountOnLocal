/**
 * Splitting the geocoder's answer back into fields.
 *
 * The US Census geocoder returns a single corrected string --
 * "1102 CONGRESS AVE, AUSTIN, TX, 78701" -- and the corrections it makes
 * are not cosmetic. A tester typed ZIP 77429 for an Austin address and the
 * geocoder read it as 78701; 77429 is Cypress, about 165 miles away. The
 * point it returned was correct, so eligibility passed, and the record kept
 * saying the house was near Houston.
 *
 * Everything downstream reads those fields: staff looking up an address,
 * the deduplication that stops one house becoming two rows, and the density
 * analytics that decide which areas are worth launching in. A ZIP that is
 * wrong by a city corrupts all three quietly.
 *
 * ## Failing safely matters more than parsing cleverly
 *
 * This is a third party's string and its shape is not promised. A parse
 * that half-works would put a city name in a postcode field, which is worse
 * than not parsing at all -- so anything that does not look exactly like
 * four comma-separated parts with a real state and a real ZIP returns null,
 * and the caller keeps what the customer typed.
 */

export type NormalisedParts = {
  line1: string
  city: string
  region: string
  postalCode: string
}

const STATE = /^[A-Z]{2}$/
const ZIP = /^[0-9]{5}(-[0-9]{4})?$/

/**
 * Parses a Census-style normalised address, or returns null.
 *
 * Null is a normal answer, not a failure: the caller falls back to what was
 * typed, which is exactly what happened before this existed.
 */
export function parseNormalisedAddress(normalised: string | null | undefined): NormalisedParts | null {
  if (typeof normalised !== 'string') return null

  const parts = normalised
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)

  // line1, city, state, zip. More or fewer means this is not the shape we
  // know how to read, and guessing which part is which is how a city ends
  // up in a postcode column.
  if (parts.length !== 4) return null

  const [line1, city, region, postalCode] = parts as [string, string, string, string]
  if (!STATE.test(region)) return null
  if (!ZIP.test(postalCode)) return null
  if (line1.length === 0 || city.length === 0) return null

  return { line1, city, region, postalCode }
}

/**
 * Whether the geocoder materially disagreed with what somebody typed.
 *
 * Case and spacing are ignored: "1100 Congress Ave" against
 * "1100 CONGRESS AVE" is the same address written differently, and telling
 * somebody it was corrected would be noise. A different ZIP or a different
 * street is worth knowing about.
 */
export function differsMaterially(
  typed: { line1: string; city: string; region: string; postalCode: string },
  parsed: NormalisedParts,
): boolean {
  const flat = (s: string) => s.trim().toUpperCase().replace(/[.,]/g, '').replace(/\s+/g, ' ')
  return (
    flat(typed.line1) !== flat(parsed.line1) ||
    flat(typed.city) !== flat(parsed.city) ||
    flat(typed.region) !== flat(parsed.region) ||
    typed.postalCode.slice(0, 5) !== parsed.postalCode.slice(0, 5)
  )
}
