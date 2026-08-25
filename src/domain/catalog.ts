/**
 * Service catalog rules.
 *
 * CLAUDE.md rule 3: the catalog is a server-owned allowlist. A provider
 * selects from it and may override only price, schedule, capacity, area and
 * approved wording. They cannot add a category, change a risk tier, or widen
 * scope through free text.
 *
 * SAFETY_TRUST_POLICY section 5 gives the concrete example: a provider must
 * not be able to turn `manual yard cleanup` into `chainsaw tree trimming`
 * through a description.
 */

import type { AgeBand } from './age'
import { isGuardianCleared, type GuardianState } from './guardian'

export type RiskTier = 'A' | 'B' | 'C' | 'X'

export type CatalogService = {
  id: string
  code: string
  name: string
  riskTier: RiskTier
  minProviderAge: number
  /** Tier B: a guardian must approve this category specifically. */
  guardianExplicitApproval: boolean
  active: boolean
}

export type OfferDenial =
  | 'SERVICE_NOT_AVAILABLE'
  | 'PROVIDER_TOO_YOUNG'
  | 'ADULT_ONLY_CATEGORY'
  | 'GUARDIAN_APPROVAL_REQUIRED'
  | 'CATEGORY_NOT_APPROVED_BY_GUARDIAN'

export type OfferDecision = { allowed: true } | { allowed: false; code: OfferDenial }

/**
 * May this provider offer this catalog service?
 *
 * Age is passed as completed years rather than a band, because a catalog
 * entry may set a minimum above 13 and the band alone cannot answer that.
 */
export function canOfferService(args: {
  service: CatalogService
  ageInYears: number
  band: AgeBand
  guardianState: GuardianState
  /** Catalog codes the guardian has explicitly approved for this provider. */
  guardianApprovedCodes: readonly string[]
}): OfferDecision {
  const { service, ageInYears, band, guardianState, guardianApprovedCodes } = args

  // Tier X is prohibited outright and should never be active, but an
  // inactive-check alone would let a mistakenly-active row through.
  if (service.riskTier === 'X' || !service.active) {
    return { allowed: false, code: 'SERVICE_NOT_AVAILABLE' }
  }

  if (service.riskTier === 'C' && band !== 'adult') {
    return { allowed: false, code: 'ADULT_ONLY_CATEGORY' }
  }

  if (ageInYears < service.minProviderAge) {
    return { allowed: false, code: 'PROVIDER_TOO_YOUNG' }
  }

  if (band === 'minor') {
    if (!isGuardianCleared(guardianState)) {
      return { allowed: false, code: 'GUARDIAN_APPROVAL_REQUIRED' }
    }
    // Tier B needs approval of this category specifically, not just general
    // guardian consent -- a parent who agreed to bin service has not thereby
    // agreed to their child walking strangers' dogs.
    if (service.guardianExplicitApproval && !guardianApprovedCodes.includes(service.code)) {
      return { allowed: false, code: 'CATEGORY_NOT_APPROVED_BY_GUARDIAN' }
    }
  }

  return { allowed: true }
}

/**
 * Wording a provider may not use, because it describes work outside every
 * launch category.
 *
 * This is a tripwire, not a filter. It exists to catch the obvious attempt
 * and route it to review; the real defence is that the catalog governs what
 * the service IS, whatever the description says. Anything matched here is
 * flagged for a human rather than silently rewritten.
 */
const PROHIBITED_DESCRIPTION_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bladders?\b/i, reason: 'ladders' },
  { pattern: /\broof(ing|top)?\b/i, reason: 'roof work' },
  { pattern: /\bchain\s?saws?\b/i, reason: 'powered cutting tools' },
  // Bare "mow" matters: "I also mow lawns" is the natural phrasing, and an
  // earlier pattern anchored on "lawn mowing" missed it entirely.
  { pattern: /\bmow(s|ing|er|ers)?\b|\bweed\s?whack|\bleaf\s?blow/i, reason: 'powered equipment' },
  { pattern: /\bpesticides?\b|\bherbicides?\b/i, reason: 'regulated chemicals' },
  { pattern: /\b(babysit|baby-sit|childcare|child care|nanny)/i, reason: 'childcare' },
  { pattern: /\b(house\s?sit|overnight)/i, reason: 'overnight or house sitting' },
  { pattern: /\b(drive|driving|ride|rides|transport)\b/i, reason: 'transporting people' },
  { pattern: /\binside\b|\bindoors?\b|\binterior\b/i, reason: 'entering a home' },
  { pattern: /\b(medication|medicine|elder\s?care)\b/i, reason: 'medical or elder care' },
  { pattern: /\b(cash|venmo|zelle|paypal|cashapp)\b/i, reason: 'off-platform payment' },
]

export type DescriptionFlag = { reason: string; match: string }

/** Returns every prohibited-scope signal in provider free text. Empty means clean. */
export function flagProhibitedWording(text: string): DescriptionFlag[] {
  const flags: DescriptionFlag[] = []
  for (const { pattern, reason } of PROHIBITED_DESCRIPTION_PATTERNS) {
    const m = pattern.exec(text)
    if (m) flags.push({ reason, match: m[0] })
  }
  return flags
}
