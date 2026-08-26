/**
 * What may leave the building.
 *
 * PRD section 25 lists the funnel events. TECHNICAL_SPEC section 17 lists
 * what must never accompany them: a full customer address, a date of birth,
 * guardian identity data, a gate code, a private message body, a raw photo
 * URL, payment method details. It closes with the instruction that shapes
 * this module -- "Use stable opaque IDs and coarse geography where analytics
 * needs segmentation."
 *
 * ## An allowlist, not a denylist
 *
 * Everywhere else in this codebase a check refuses what it recognises as
 * dangerous. Analytics is the one place that is the wrong way round.
 *
 * A denylist protects against the fields somebody thought of. Analytics
 * payloads are assembled in a hurry, by whoever is adding a funnel step,
 * from whatever object happens to be in scope -- and the object in scope on
 * a checkout page is the one with the address in it. The failure mode is
 * not a developer typing `gate_code`; it is `...subscription` spreading
 * forty fields into a vendor's database.
 *
 * So a property is dropped unless it is named here. A new dimension takes
 * one line and a moment's thought about whether it should exist, which is
 * exactly the moment worth forcing.
 *
 * ## Why this matters more than the notification check
 *
 * A notification goes to one person who already knows their own address.
 * Analytics goes to a third party, is retained on their schedule rather
 * than ours, and is queryable by anyone with a dashboard login. The same
 * data is a different risk in the two places.
 */

/** PRD section 25's funnel, exactly. */
export const ANALYTICS_EVENTS = [
  'provider_signup_started',
  'age_gate_passed',
  'guardian_invited',
  'guardian_verified',
  'business_draft_created',
  'service_configured',
  'payout_onboarding_started',
  'payout_ready',
  'business_published',
  'flyer_generated',
  'share_link_copied',
  'service_page_viewed',
  'address_checked',
  'address_eligible',
  'checkout_started',
  'subscription_started',
  'occurrence_completed',
  'occurrence_issue_reported',
  'subscription_paused',
  'subscription_canceled',
  'review_submitted',
  'referral_converted',
] as const

export type AnalyticsEvent = (typeof ANALYTICS_EVENTS)[number]

export function isAnalyticsEvent(v: unknown): v is AnalyticsEvent {
  return typeof v === 'string' && (ANALYTICS_EVENTS as readonly string[]).includes(v)
}

/**
 * Every property that may be sent, and nothing else.
 *
 * Opaque ids, enumerations, counts, money in cents, and coarse geography.
 * Notice what is absent and why:
 *
 *   - no `postal_code`, only `postal_prefix`. A full US ZIP identifies a
 *     few thousand households; three digits identifies a region, which is
 *     all a funnel needs to know.
 *   - no user email, name, or date of birth. `age_band` answers every
 *     question a funnel actually asks about age.
 *   - no free text at all. Free text is where an address ends up when
 *     somebody pastes a form field into a payload.
 */
export const ALLOWED_PROPERTIES: ReadonlySet<string> = new Set([
  // Opaque identifiers. Stable, meaningless outside our own database.
  'user_id',
  'provider_id',
  'customer_id',
  'business_id',
  'service_id',
  'subscription_id',
  'occurrence_id',
  'review_id',
  'incident_id',
  'referral_code',

  // Enumerations.
  'age_band',
  'guardian_state',
  'catalog_code',
  'price_unit',
  'frequency',
  'subscription_state',
  'occurrence_state',
  'severity',
  'travel_mode',
  'channel',
  'source',
  'result',
  'reason_code',

  // Coarse geography. Three digits, never five.
  'postal_prefix',
  'region',
  'timezone',

  // Numbers.
  'price_cents',
  'amount_cents',
  'platform_fee_cents',
  'occurrence_count',
  'stop_count',
  'capacity',
  'active_customers',
  'utilization',
  'rating',
  'billing_cycle_weeks',
  'estimated_minutes',
  'estimated_metres',

  // Booleans.
  'eligible',
  'at_capacity',
  'is_minor',
  'guardian_required',
  'credited',
  'first_customer',
])

export type AnalyticsValue = string | number | boolean | null

export type ScrubResult = {
  /** What is safe to send. */
  properties: Record<string, AnalyticsValue>
  /** Property names that were dropped, for a development-time warning. */
  dropped: string[]
}

/**
 * Reduces a payload to what is allowed.
 *
 * Drops rather than throws. An analytics call is not worth failing a
 * checkout over, and a developer who spread a subscription object into an
 * event needs a loud warning rather than a customer seeing an error.
 *
 * Nested objects are dropped entirely rather than walked. A funnel event
 * has no legitimate need for structure, and walking one would mean deciding
 * what `address.city` is called in the allowlist -- which is how an address
 * ends up half-allowed.
 */
export function scrubProperties(input: Record<string, unknown>): ScrubResult {
  const properties: Record<string, AnalyticsValue> = {}
  const dropped: string[] = []

  for (const [key, value] of Object.entries(input)) {
    if (!ALLOWED_PROPERTIES.has(key)) {
      dropped.push(key)
      continue
    }

    if (value === null || typeof value === 'boolean' || typeof value === 'number') {
      properties[key] = value as AnalyticsValue
      continue
    }

    if (typeof value === 'string') {
      // An allowed key holding a suspiciously long string is a payload
      // somebody has put free text into. Truncating would send half an
      // address; dropping sends none of it.
      if (value.length > 64) {
        dropped.push(key)
        continue
      }
      properties[key] = value
      continue
    }

    // Objects, arrays, functions, undefined.
    dropped.push(key)
  }

  return { properties, dropped }
}

/**
 * Three digits of a postal code.
 *
 * TECHNICAL_SPEC section 17 asks for coarse geography. A full US ZIP covers
 * a few thousand households and, combined with a service day and a route,
 * is closer to an address than a region. Three digits is a chunk of a
 * state.
 */
export function postalPrefix(postalCode: string): string | null {
  const digits = postalCode.replace(/\D/g, '')
  if (digits.length < 5) return null
  return digits.slice(0, 3)
}

export type AnalyticsEnvelope = {
  event: AnalyticsEvent
  properties: Record<string, AnalyticsValue>
  /** Opaque, stable, meaningless outside our database. */
  userId?: string | undefined
}

export type BuildResult =
  | { ok: true; envelope: AnalyticsEnvelope; dropped: string[] }
  | { ok: false; message: string }

/**
 * Builds an event, or refuses.
 *
 * An unknown event name is refused rather than passed through. PRD section
 * 25 is a defined funnel, and an events table that accumulates whatever
 * anybody happened to fire stops being answerable to a question.
 */
export function buildEvent(args: {
  event: unknown
  properties?: Record<string, unknown> | undefined
  userId?: string | undefined
}): BuildResult {
  if (!isAnalyticsEvent(args.event)) {
    return {
      ok: false,
      message: `Unknown analytics event: ${String(args.event)}. Add it to PRD section 25 first.`,
    }
  }

  const { properties, dropped } = scrubProperties(args.properties ?? {})

  return {
    ok: true,
    envelope: {
      event: args.event,
      properties,
      ...(args.userId ? { userId: args.userId } : {}),
    },
    dropped,
  }
}
