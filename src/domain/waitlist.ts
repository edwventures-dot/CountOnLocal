/**
 * Pre-launch waitlist.
 *
 * The landing page collects interest before the product opens. What it
 * collects is deliberately thin, because a waitlist is not an account and
 * should not behave like one.
 *
 * Not collected, on purpose:
 *
 *   - date of birth. SAFETY_TRUST_POLICY section 1 makes DOB private and
 *     section 17 forbids collecting an exact age we have no use for. A
 *     waitlist grants nothing, so there is nothing to gate on age yet. The
 *     13+ rule is stated on the page and enforced at real signup.
 *   - name, street address, phone, school. Section 17 again: data
 *     minimisation. None of it changes who we email at launch.
 *
 * Postal code IS collected, optionally, and it is the one field that earns
 * its place: launch geography is chosen by density (GO_TO_MARKET), and a
 * five-digit ZIP is the coarse geography TECHNICAL_SPEC section 17 permits
 * for segmentation. It is not a street address and cannot be resolved to a
 * household.
 */

export const WAITLIST_ROLES = ['provider', 'customer', 'guardian'] as const

export type WaitlistRole = (typeof WAITLIST_ROLES)[number]

export type WaitlistSignup = {
  email: string
  role: WaitlistRole
  postalCode: string | null
}

export type WaitlistValidation =
  | { ok: true; value: WaitlistSignup }
  | { ok: false; fieldErrors: Record<string, string> }

/**
 * Deliberately permissive. The authoritative test of an address is whether a
 * message to it arrives; a stricter regex here only rejects real people with
 * unusual-looking addresses. We check the shape, lowercase it, and move on.
 */
const EMAIL_SHAPE = /^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/

const EMAIL_MAX = 254

/** US five-digit ZIP, optionally ZIP+4. Only the first five are kept. */
const POSTAL_SHAPE = /^([0-9]{5})(-[0-9]{4})?$/

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase()
}

export function isWaitlistRole(v: unknown): v is WaitlistRole {
  return typeof v === 'string' && (WAITLIST_ROLES as readonly string[]).includes(v)
}

/**
 * Validates and normalises one signup.
 *
 * Returns every field error at once rather than the first, so the form can
 * show them together instead of making someone resubmit to find the next
 * problem.
 */
export function validateWaitlistSignup(input: {
  email?: unknown
  role?: unknown
  postalCode?: unknown
}): WaitlistValidation {
  const fieldErrors: Record<string, string> = {}

  const email = typeof input.email === 'string' ? normalizeEmail(input.email) : ''
  if (!email) {
    fieldErrors.email = 'Enter your email address.'
  } else if (email.length > EMAIL_MAX) {
    fieldErrors.email = 'That email address is too long.'
  } else if (!EMAIL_SHAPE.test(email)) {
    fieldErrors.email = 'That does not look like an email address.'
  }

  if (!isWaitlistRole(input.role)) {
    fieldErrors.role = 'Choose how you would use Count On Local.'
  }

  // Optional. Blank is fine; wrong is not, because a bad ZIP silently
  // corrupts the density picture we are collecting it for.
  let postalCode: string | null = null
  const rawPostal = typeof input.postalCode === 'string' ? input.postalCode.trim() : ''
  if (rawPostal) {
    const m = POSTAL_SHAPE.exec(rawPostal)
    if (!m) {
      fieldErrors.postalCode = 'Enter a 5-digit ZIP code, or leave it blank.'
    } else {
      postalCode = m[1] ?? null
    }
  }

  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors }

  return { ok: true, value: { email, role: input.role as WaitlistRole, postalCode } }
}
