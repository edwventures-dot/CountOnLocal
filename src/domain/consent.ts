/**
 * The consent documents, as data.
 *
 * ## Why the text lives here and not in a CMS
 *
 * ESIGN/UETA asks what the signer actually saw. Storing "guardian consent
 * v3" against a signature is only meaningful if v3 can be produced later,
 * word for word, and shown to be the thing on screen at the time. So the
 * canonical text is in the repository, versioned, and hashed -- and the
 * page that collects the signature renders from this same array rather
 * than from a copy somebody pasted into JSX.
 *
 * If marketing edits the wording, the version must move with it. Editing
 * the text without bumping the version would leave old signatures pointing
 * at a hash that no longer matches anything, which is worse than no record
 * at all: it looks like provenance and is not.
 *
 * ## Itemized, not blanket
 *
 * Each point is acknowledged separately. That is the owner's decision from
 * the legal pass and it has a real consequence in code: the stored record
 * keeps which items were checked, so "they agreed" can be answered per
 * point rather than as one boolean.
 *
 * ## No guardian consent on this branch
 *
 * The guardian consent document and the public-listing consent that went
 * with it are gone, along with everything else about minors. Both sides
 * attest to being adults and nothing collects a date of birth -- see
 * PROVIDER_ATTESTATION below for why that is a deliberate design choice
 * rather than a simplification.
 *
 * Source copy: marketing/legal/consent-and-attestations.md
 */

export type ConsentKind = 'provider_attestation' | 'customer_attestation'

export type ConsentItem = {
  /** Stable across wording changes. The record stores these. */
  key: string
  text: string
}

export type ConsentDocument = {
  kind: ConsentKind
  /**
   * Bump on ANY wording change, including a typo fix. A signature points
   * at a version and a hash; silently editing text under a version makes
   * both meaningless.
   */
  version: string
  title: string
  intro: string
  items: readonly ConsentItem[]
  /** The sentence directly above the signature field. */
  statement: string
}

/**
 * `{{minor_name}}` is substituted when rendered. It is deliberately NOT
 * substituted before hashing -- the hash identifies the document, not the
 * particular teenager, so two guardians signing the same version produce
 * the same hash and a change of wording is visible as a change of hash.
 */
/**
 * What a provider confirms before listing a service.
 *
 * ## Why this is an attestation and not a date of birth
 *
 * The full product asked for a date of birth, because the age bands
 * genuinely mattered: under 13 refused, 13-17 gated on a guardian, 18+
 * independent. With minors gone there is one band, and the only question
 * is whether somebody is an adult.
 *
 * Asking for a birth date to answer a yes/no question would be worse than
 * useless here. FTC guidance is explicit that an operator who asks for and
 * receives a date of birth showing a user is under 13 has actual knowledge
 * of that fact for COPPA purposes -- so collecting it on a public site
 * creates an obligation that not collecting it does not. The full product
 * carried exactly that gap: an under-13 signup was refused, but only after
 * an account already existed holding their email.
 *
 * An attestation answers the question, keeps the answer, and never learns
 * anything it would then have to protect.
 */
export const PROVIDER_ATTESTATION: ConsentDocument = {
  kind: 'provider_attestation',
  version: '2026-09-07.1',
  title: 'Before you list a service',
  intro: 'Please read each point and check the box to confirm you understand it.',
  items: [
    { key: 'is_adult', text: 'I am 18 or older.' },
    {
      key: 'own_arrangement',
      text: 'I understand Count On Local does not employ me, pay me, or take a cut. Whatever I charge is between me and my customer, and I arrange payment with them directly.',
    },
    {
      key: 'no_background_checks',
      text: 'I understand Count On Local does NOT run background checks on anyone, including my customers.',
    },
    {
      key: 'my_own_safety',
      text: 'I am responsible for deciding which work I take and whether it is safe for me to do it.',
    },
    {
      key: 'not_emergency_service',
      text: 'I understand Count On Local is not an emergency service.',
    },
  ],
  statement: 'I agree to each of the points above.',
}

export const CUSTOMER_ATTESTATION: ConsentDocument = {
  kind: 'customer_attestation',
  version: '2026-09-07.1',
  title: 'Before you subscribe',
  intro: 'Please read each point and check the box to confirm you understand it.',
  items: [
    { key: 'is_adult', text: 'I am 18 or older.' },
    {
      key: 'no_background_checks',
      text: 'I understand Count On Local does NOT run background checks. I am choosing to hire someone in my neighborhood I know and trust; vetting them is my responsibility.',
    },
    {
      key: 'pay_the_provider_directly',
      text: 'I understand Count On Local does not take payment. I pay my provider directly, and what I owe them is between us.',
    },
    {
      key: 'accurate_address_and_dog',
      text: 'I will give an accurate service address, and for dog walking, honest information about my dog — size, what they are walked on, and whether they have ever bitten anyone. My walker sees this before they arrive.',
    },
    {
      key: 'messaging',
      text: 'I understand there is in-app messaging and how to block or report.',
    },
    {
      key: 'not_emergency_service',
      text: 'I understand Count On Local is not an emergency service.',
    },
  ],
  statement: 'I agree to each of the points above.',
}

export const CONSENT_DOCUMENTS: Readonly<Record<ConsentKind, ConsentDocument>> = {
  provider_attestation: PROVIDER_ATTESTATION,
  customer_attestation: CUSTOMER_ATTESTATION,
}


/**
 * The exact bytes that get hashed.
 *
 * Deterministic and order-sensitive: reordering the items changes the
 * hash, which is correct -- a different order is a different document to
 * somebody reading it. Item keys are included so a wording change that
 * kept the same key is still a different hash.
 */
export function canonicalText(doc: ConsentDocument): string {
  return [
    `kind:${doc.kind}`,
    `version:${doc.version}`,
    `title:${doc.title}`,
    `intro:${doc.intro}`,
    ...doc.items.map((i) => `item:${i.key}:${i.text}`),
    `statement:${doc.statement}`,
  ].join('\n')
}

/** Substitutes the placeholders for display only. Never before hashing. */
export function renderText(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => values[key] ?? whole)
}

export type AcknowledgementCheck =
  | { ok: true }
  | { ok: false; missing: string[]; message: string }

/**
 * Every item must be acknowledged.
 *
 * Itemized consent that accepts a partial set is a blanket consent with
 * extra steps. An unchecked box is a point the signer did not agree to,
 * and there is no version of this document that is meaningful without all
 * of them.
 */
export function checkAcknowledgements(
  doc: ConsentDocument,
  acknowledged: readonly string[],
): AcknowledgementCheck {
  const given = new Set(acknowledged)
  const missing = doc.items.filter((i) => !given.has(i.key)).map((i) => i.key)

  if (missing.length === 0) return { ok: true }

  return {
    ok: false,
    missing,
    message: `Please confirm every point. ${missing.length} ${missing.length === 1 ? 'is' : 'are'} still unchecked.`,
  }
}

/**
 * A typed signature is only a signature if it is actually a name.
 *
 * Deliberately loose: it refuses blanks and obvious non-answers, and does
 * not attempt to validate that a human is called this. A name check that
 * rejects real names is worse than one that accepts a fake, because the
 * fake is caught by the identity record stored alongside it.
 */
export function checkTypedSignature(input: unknown): { ok: true; name: string } | { ok: false; message: string } {
  const name = typeof input === 'string' ? input.trim().replace(/\s+/g, ' ') : ''

  if (name.length < 3) {
    return { ok: false, message: 'Type your full legal name to sign.' }
  }
  if (name.length > 120) {
    return { ok: false, message: 'That name is too long.' }
  }
  if (!/[a-zA-Z]/.test(name)) {
    return { ok: false, message: 'Type your full legal name to sign.' }
  }

  return { ok: true, name }
}
