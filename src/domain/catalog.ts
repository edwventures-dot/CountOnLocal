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
 *
 * ## What the age rules became
 *
 * The full product decided this from a date of birth, a guardian state and
 * a per-category guardian approval, because a 14-year-old and a 17-year-old
 * could offer different things. Every provider is an adult here, so all
 * three inputs collapse and what remains is the part that was always doing
 * the real work: the tier and whether the row is active.
 *
 * minProviderAge and guardianExplicitApproval stay on the type because the
 * catalog rows in the database still carry them. They are read and ignored
 * rather than deleted, so a future branch that puts minors back does not
 * have to reconstruct a column.
 */



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

export type OfferDenial = 'SERVICE_NOT_AVAILABLE'

export type OfferDecision = { allowed: true } | { allowed: false; code: OfferDenial }

/**
 * May a provider offer this catalog service?
 *
 * Tier X is prohibited outright and should never be active, but checking
 * only `active` would let a mistakenly-active row through -- so both are
 * checked, the same way they were before.
 */
export function canOfferService(args: { service: CatalogService }): OfferDecision {
  const { service } = args

  if (service.riskTier === 'X' || !service.active) {
    return { allowed: false, code: 'SERVICE_NOT_AVAILABLE' }
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
