/**
 * Where the platform may operate, and for which services.
 *
 * From the product owner's response of 2026-08-30, item 9:
 *
 *   "Not Texas-only. Counsel must review material requirements in each U.S.
 *    jurisdiction where the platform operates and flag any state that must
 *    be restricted until required controls exist."
 *
 * This module is the lever counsel asked for. It decides nothing itself --
 * every actual restriction is a row in `jurisdiction_rules` that somebody
 * with authority put there, with a reason attached. What lives here is the
 * shape of the question and the order the answers are considered in.
 *
 * ## Two postures, because the right one is not engineering's call
 *
 * `open` -- operate everywhere except states explicitly restricted. This
 * matches the owner's stated position: the platform is multi-state, and
 * counsel flags what to hold back.
 *
 * `allowlist` -- operate ONLY in states explicitly permitted. This is what
 * a staged launch looks like, and the posture to switch to if counsel comes
 * back with "we have cleared these five states and no others."
 *
 * Both are supported and the posture is one setting, because the review has
 * not happened yet and the answer may well be the second one. Building only
 * the posture we expect today would mean rebuilding this under time pressure
 * the week counsel disagrees.
 *
 * ## Why restrictions are per state AND per service
 *
 * The blocking question is rarely "may we operate in Ohio". It is closer to
 * "may a fifteen-year-old be paid to walk a dog in Ohio" -- minor-labour
 * rules attach to the kind of work, not to the marketplace. A rule with no
 * catalog code covers the whole state; a rule with one covers that service
 * there and leaves the rest alone.
 *
 * ## What this deliberately does NOT do
 *
 * It does not guess. An unrecognised state code is not quietly allowed on
 * the theory that it is probably fine, and it is not quietly blocked on the
 * theory that caution is free -- blocking a real customer in a state nobody
 * reviewed is a silent product failure that looks like a bug. Under `open`
 * an unlisted state is allowed, under `allowlist` it is refused, and in
 * both cases that is a decision somebody made rather than a default nobody
 * noticed.
 */

/** What a rule does. */
export type JurisdictionStatus =
  /** Explicitly cleared. Only meaningful under the allowlist posture. */
  | 'allowed'
  /** Not available, and the customer is told plainly. */
  | 'blocked'

export type JurisdictionPosture = 'open' | 'allowlist'

export type JurisdictionRule = {
  /** Two-letter US state or territory code, uppercase. */
  region: string
  status: JurisdictionStatus
  /**
   * The service this applies to. Absent means the whole state.
   *
   * Server-owned catalog codes only -- the same allowlist providers pick
   * from, so a rule cannot reference work the platform does not offer.
   */
  catalogCode?: string | undefined
  /**
   * Why, in words a customer could be shown a summary of and a regulator
   * could be shown in full. Never optional: a restriction nobody wrote a
   * reason for cannot be reviewed, renewed, or lifted with confidence.
   */
  reason: string
}

export type JurisdictionCheck =
  | { allowed: true }
  | {
      allowed: false
      code: 'STATE_BLOCKED' | 'SERVICE_BLOCKED_IN_STATE' | 'STATE_NOT_CLEARED'
      /** Shown to the person. Says what, not why in legal terms. */
      message: string
      /** The rule that decided it, for the audit row. Absent for posture. */
      rule?: JurisdictionRule | undefined
    }

/** Normalises a region the way the rules are stored. */
export function normaliseRegion(region: string): string {
  return region.trim().toUpperCase()
}

/**
 * May this service be sold to this address?
 *
 * Order matters and is deliberate:
 *
 *   1. a block on the specific service in that state
 *   2. a block on the whole state
 *   3. the posture, for a state with no rules at all
 *
 * Service-specific first, because a state that blocks dog walking by minors
 * has not blocked lawn mowing, and reversing the order would refuse both.
 */
export function checkJurisdiction(args: {
  region: string
  catalogCode?: string | undefined
  rules: readonly JurisdictionRule[]
  posture: JurisdictionPosture
}): JurisdictionCheck {
  const region = normaliseRegion(args.region)
  const here = args.rules.filter((r) => normaliseRegion(r.region) === region)

  if (args.catalogCode) {
    const onService = here.find(
      (r) => r.catalogCode === args.catalogCode && r.status === 'blocked',
    )
    if (onService) {
      return {
        allowed: false,
        code: 'SERVICE_BLOCKED_IN_STATE',
        message: `This service is not available in ${region} yet.`,
        rule: onService,
      }
    }
  }

  const onState = here.find((r) => r.catalogCode == null && r.status === 'blocked')
  if (onState) {
    return {
      allowed: false,
      code: 'STATE_BLOCKED',
      message: `Count On Local is not available in ${region} yet.`,
      rule: onState,
    }
  }

  if (args.posture === 'allowlist') {
    const cleared = here.some((r) => r.status === 'allowed' && r.catalogCode == null)
    const clearedForService =
      args.catalogCode != null &&
      here.some((r) => r.status === 'allowed' && r.catalogCode === args.catalogCode)

    if (!cleared && !clearedForService) {
      return {
        allowed: false,
        code: 'STATE_NOT_CLEARED',
        // Deliberately the same sentence a blocked state gets. "We have not
        // reviewed your state yet" invites an argument the support agent
        // cannot win and tells a stranger about our compliance posture.
        message: `Count On Local is not available in ${region} yet.`,
      }
    }
  }

  return { allowed: true }
}

/**
 * Every state where something is restricted, for the admin console.
 *
 * Returned sorted so the list does not reshuffle between page loads, which
 * makes a diff between two screenshots meaningless.
 */
export function restrictedRegions(rules: readonly JurisdictionRule[]): string[] {
  return [
    ...new Set(rules.filter((r) => r.status === 'blocked').map((r) => normaliseRegion(r.region))),
  ].sort()
}

/**
 * Whether a string is a time zone this runtime actually knows.
 *
 * Added with the multi-state work. Every service created through the
 * builder was stamped `America/Chicago` regardless of where the provider
 * lived, which is invisible in Texas and wrong everywhere else: a route is
 * promoted at local midnight, so a Phoenix provider's Tuesday started on
 * Monday evening.
 *
 * The zone now comes from the provider's own browser, which is both
 * accurate and free -- they are standing where their route is. That makes
 * it caller-supplied data reaching a stored schedule, so it is validated
 * here rather than trusted.
 *
 * Uses the runtime's own database rather than a hand-kept list, because a
 * hand-kept list is wrong the first time a zone is renamed.
 */
export function isKnownTimeZone(zone: string): boolean {
  if (typeof zone !== 'string' || zone.length === 0 || zone.length > 64) return false
  try {
    // Throws RangeError on anything Intl does not recognise.
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

/**
 * The zone to store for a schedule.
 *
 * Falls back to Central only when the browser offered nothing usable, and
 * that fallback is a last resort rather than the default it used to be.
 */
export function resolveTimeZone(offered: string | undefined | null): string {
  return offered && isKnownTimeZone(offered) ? offered : 'America/Chicago'
}
