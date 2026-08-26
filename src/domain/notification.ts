/**
 * What a notification may say.
 *
 * PRD section 20 lists the events. TECHNICAL_SPEC section 12 adds the
 * constraint that makes this a domain module rather than a template
 * concern: "No sensitive address/access code in notification previews."
 * CLAUDE.md rule 13 is blunter -- gate and access codes never reach an
 * email subject, a push preview, a log line or an analytics payload.
 *
 * ## Why this is checked here and not in the template
 *
 * A notification's subject and preview are the parts that appear on a
 * locked phone, in a notification shade, on a smartwatch. Nobody has to
 * open anything for them to be read, and the person reading is not
 * necessarily the recipient.
 *
 * That makes them the one place in the product where "it is only shown to
 * the customer" stops being true. A template that happens to interpolate an
 * address today is one edit away from doing it in the preview, so the check
 * lives at the boundary every notification passes through, and it refuses
 * rather than sanitising: silently stripping an address would hide the bug
 * that put it there.
 *
 * The body is a different matter -- it is behind a click, and for email it
 * is the only place some of this can go. What the body may contain is still
 * narrow, but it is not this module's job.
 */

export type NotificationChannel = 'email' | 'sms' | 'push'

/** Event names from PRD section 20. */
export const NOTIFICATION_KINDS = [
  'guardian.approval_requested',
  'guardian.approved',
  'guardian.revoked',
  'business.published',
  'subscription.new_subscriber',
  'subscription.payment_failed',
  'subscription.canceled',
  'occurrence.upcoming',
  'occurrence.completed',
  'occurrence.credited',
  'cycle.settled',
  'payout.sent',
  'review.received',
  'safety.alert',
] as const

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number]

export function isNotificationKind(v: unknown): v is NotificationKind {
  return typeof v === 'string' && (NOTIFICATION_KINDS as readonly string[]).includes(v)
}

/**
 * Kinds a recipient may not turn off.
 *
 * PRD section 20: email is the "mandatory transactional baseline", and
 * marketing SMS needs explicit consent. A payment failure or a safety alert
 * is not marketing -- suppressing it would leave somebody's card broken or
 * their child in a situation nobody told them about.
 */
export const UNSUPPRESSIBLE_KINDS: ReadonlySet<NotificationKind> = new Set([
  'guardian.approval_requested',
  'guardian.revoked',
  'subscription.payment_failed',
  'safety.alert',
])

export type PreviewCheck =
  | { ok: true }
  | { ok: false; code: PreviewViolation; message: string }

export type PreviewViolation =
  | 'looks_like_address'
  | 'looks_like_access_code'
  | 'too_long'
  | 'empty'

const SUBJECT_MAX = 120
const PREVIEW_MAX = 200

/**
 * A street address in the wild: a number followed by words, ending in
 * something that reads like a thoroughfare.
 *
 * Deliberately loose. The cost of a false positive is that somebody has to
 * reword a subject line; the cost of a false negative is a customer's home
 * address on a stranger's lock screen.
 */
const ADDRESS_SHAPE =
  /\b\d{1,6}\s+[A-Za-z][A-Za-z.'-]*(\s+[A-Za-z][A-Za-z.'-]*){0,3}\s+(st|street|rd|road|ave|avenue|dr|drive|ln|lane|blvd|boulevard|ct|court|way|terrace|ter|place|pl|circle|cir|trail|trl|parkway|pkwy)\b\.?/i

/** A US ZIP, which pins a preview to a neighbourhood. */
const POSTCODE_SHAPE = /\b\d{5}(-\d{4})?\b/

/**
 * Anything that reads like a code somebody could use at a gate.
 *
 * Catches "gate code 4417", "code: 8891", "keypad 1234#". A bare number is
 * not enough -- "18 stops" and "$13.80" are legitimate -- so the trigger is
 * a code-ish word next to digits.
 */
const ACCESS_CODE_SHAPE =
  /\b(gate|access|door|keypad|lock|entry|pin|code)\b[^.\n]{0,12}?\d{3,}/i

/**
 * Is this string safe to show on a locked phone?
 *
 * Applied to subject and preview only.
 */
export function checkPreviewText(text: string, limit: number): PreviewCheck {
  const trimmed = text.trim()

  if (!trimmed) {
    return { ok: false, code: 'empty', message: 'A notification needs something to say.' }
  }
  if (trimmed.length > limit) {
    return {
      ok: false,
      code: 'too_long',
      message: `Keep it under ${limit} characters; this is ${trimmed.length}.`,
    }
  }
  if (ACCESS_CODE_SHAPE.test(trimmed)) {
    return {
      ok: false,
      code: 'looks_like_access_code',
      message:
        'This looks like an access code. CLAUDE.md rule 13: those never appear in a subject or a preview.',
    }
  }
  if (ADDRESS_SHAPE.test(trimmed) || POSTCODE_SHAPE.test(trimmed)) {
    return {
      ok: false,
      code: 'looks_like_address',
      message:
        'This looks like a street address. TECHNICAL_SPEC 12: no address in a notification preview.',
    }
  }

  return { ok: true }
}

export type DraftNotification = {
  kind: NotificationKind
  channel: NotificationChannel
  destination: string
  subject?: string | undefined
  preview?: string | undefined
  /** Ids a template resolves after the recipient authenticates. */
  payload?: Record<string, unknown> | undefined
}

export type DraftCheck =
  | { ok: true }
  | { ok: false; field: 'subject' | 'preview' | 'payload' | 'destination'; code: string; message: string }

/**
 * Keys that must never appear in a payload.
 *
 * The payload is meant to carry ids, not values. A template that needs an
 * address looks it up with the recipient's own session; putting it here
 * would copy it into a second table with different access rules, which is
 * the same mistake the audit log's redaction guards against.
 */
const FORBIDDEN_PAYLOAD_KEYS = new Set([
  'access_notes',
  'accessNotes',
  'gate_code',
  'gateCode',
  'access_code',
  'accessCode',
  'line1',
  'line2',
  'address',
  'street',
  'date_of_birth',
  'dateOfBirth',
  'dob',
  'password',
  'token',
  'card',
  'payment_method',
])

export function checkDraft(draft: DraftNotification): DraftCheck {
  if (!draft.destination.trim()) {
    return {
      ok: false,
      field: 'destination',
      code: 'empty',
      message: 'A notification needs somewhere to go.',
    }
  }

  if (draft.subject !== undefined) {
    const r = checkPreviewText(draft.subject, SUBJECT_MAX)
    if (!r.ok) return { ok: false, field: 'subject', code: r.code, message: r.message }
  }

  if (draft.preview !== undefined) {
    const r = checkPreviewText(draft.preview, PREVIEW_MAX)
    if (!r.ok) return { ok: false, field: 'preview', code: r.code, message: r.message }
  }

  if (draft.payload) {
    const offending = findForbiddenKey(draft.payload)
    if (offending) {
      return {
        ok: false,
        field: 'payload',
        code: 'forbidden_key',
        message: `"${offending}" does not belong in a notification payload. Send an id and let the template look it up.`,
      }
    }
  }

  return { ok: true }
}

/** Depth-first, because a nested object hides a key just as well. */
function findForbiddenKey(value: unknown, depth = 0): string | null {
  if (depth > 6 || value === null || typeof value !== 'object') return null

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findForbiddenKey(item, depth + 1)
      if (found) return found
    }
    return null
  }

  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_PAYLOAD_KEYS.has(key)) return key
    const found = findForbiddenKey(child, depth + 1)
    if (found) return found
  }
  return null
}

/**
 * How long to wait before trying again.
 *
 * Exponential, capped, so a provider outage does not turn into a tight loop
 * and a transient failure is not left for hours.
 */
export function backoffSeconds(attempts: number): number {
  if (attempts <= 0) return 0
  return Math.min(60 * 60 * 6, 30 * 2 ** (attempts - 1))
}

/** Attempts before a row is left for a human. */
export const MAX_ATTEMPTS = 6

export function shouldGiveUp(attempts: number): boolean {
  return attempts >= MAX_ATTEMPTS
}
