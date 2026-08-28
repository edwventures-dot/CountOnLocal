/**
 * Details a customer must give for particular kinds of work.
 *
 * At the moment that means dogs, and the reason is not administrative.
 * The customer attestation asks for "honest information about my dog
 * (size, leash/harness, and any bite history)" -- and that sentence was
 * signed by somebody before a fourteen-year-old walks to their house and
 * takes their animal down a street.
 *
 * Bite history in particular is a safety input, not a form field. A
 * provider who knows the dog has bitten before can decide not to take the
 * job, or take it differently. A provider who is told nothing cannot.
 *
 * ## Why this is a small allowlist rather than free text
 *
 * The customer already has a free-text instructions field. Putting bite
 * history there would mean the provider has to read a paragraph and
 * notice the important sentence, at seven in the morning, on a phone.
 * Structured fields can be shown as a warning; prose cannot.
 */

/** Catalog codes that require dog information before a subscription. */
export const DOG_CATALOG_CODES: ReadonlySet<string> = new Set(['dog_walking', 'dog_waste_pickup'])

export function requiresDogDetails(catalogCode: string | null | undefined): boolean {
  return typeof catalogCode === 'string' && DOG_CATALOG_CODES.has(catalogCode)
}

export const DOG_SIZES = ['small', 'medium', 'large'] as const
export type DogSize = (typeof DOG_SIZES)[number]

/**
 * Whether the dog has ever bitten a person or another animal.
 *
 * Three values rather than a boolean, and `unsure` is deliberate. A
 * rescue dog's history is often genuinely unknown, and forcing that into
 * "no" would turn an honest gap into a false reassurance. The provider is
 * told "unknown", which is the truth and is actionable.
 */
export const BITE_HISTORY = ['none', 'yes', 'unsure'] as const
export type BiteHistory = (typeof BITE_HISTORY)[number]

export type DogDetails = {
  name: string
  size: DogSize
  /** Walked on a lead, a harness, or both. Free-ish but bounded. */
  restraint: string
  biteHistory: BiteHistory
  /** Anything else. Optional, and never a substitute for the above. */
  notes?: string | undefined
}

export type ServiceDetails = { dog?: DogDetails | undefined }

export type DetailsCheck =
  | { ok: true; details: ServiceDetails }
  | { ok: false; field: string; message: string }

/**
 * Validates what a customer supplied for the service they are buying.
 *
 * Refuses rather than defaults. A missing bite history recorded as "none"
 * is worse than no record at all: it tells a provider something reassuring
 * that nobody actually said.
 */
export function checkServiceDetails(args: {
  catalogCode: string | null | undefined
  input: unknown
}): DetailsCheck {
  if (!requiresDogDetails(args.catalogCode)) return { ok: true, details: {} }

  const raw = (args.input ?? {}) as Record<string, unknown>
  const dog = (raw['dog'] ?? {}) as Record<string, unknown>

  const name = typeof dog['name'] === 'string' ? dog['name'].trim() : ''
  if (name.length < 1 || name.length > 60) {
    return { ok: false, field: 'dog.name', message: "What is the dog's name?" }
  }

  const size = dog['size']
  if (typeof size !== 'string' || !(DOG_SIZES as readonly string[]).includes(size)) {
    return { ok: false, field: 'dog.size', message: 'Choose a size.' }
  }

  const restraint = typeof dog['restraint'] === 'string' ? dog['restraint'].trim() : ''
  if (restraint.length < 2 || restraint.length > 80) {
    return {
      ok: false,
      field: 'dog.restraint',
      message: 'Say what they are walked on — a collar, a harness, both.',
    }
  }

  const biteHistory = dog['biteHistory']
  if (
    typeof biteHistory !== 'string' ||
    !(BITE_HISTORY as readonly string[]).includes(biteHistory)
  ) {
    return {
      ok: false,
      field: 'dog.biteHistory',
      message: 'Has this dog ever bitten anyone? Answer honestly, including if you are not sure.',
    }
  }

  const notes = typeof dog['notes'] === 'string' ? dog['notes'].trim().slice(0, 300) : ''

  return {
    ok: true,
    details: {
      dog: {
        name,
        size: size as DogSize,
        restraint,
        biteHistory: biteHistory as BiteHistory,
        ...(notes ? { notes } : {}),
      },
    },
  }
}

/**
 * What the provider is shown, and how loudly.
 *
 * `unsure` is treated as a warning rather than a neutral fact. An unknown
 * history is a reason to be careful, and softening it to "not known" would
 * bury the one thing worth noticing.
 */
export function dogWarning(details: ServiceDetails | null | undefined): string | null {
  const dog = details?.dog
  if (!dog) return null

  switch (dog.biteHistory) {
    case 'yes':
      return `${dog.name} has bitten before. Take care, and you can refuse this stop.`
    case 'unsure':
      return `${dog.name}'s history is not known. Treat them as unpredictable.`
    default:
      return null
  }
}

export function describeDog(details: ServiceDetails | null | undefined): string | null {
  const dog = details?.dog
  if (!dog) return null
  return `${dog.name}, ${dog.size}, walked on ${dog.restraint}`
}
