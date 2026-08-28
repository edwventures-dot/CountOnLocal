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
 * Source copy: marketing/legal/consent-and-attestations.md
 */

export type ConsentKind = 'guardian_consent' | 'public_listing_consent' | 'customer_attestation'

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
export const GUARDIAN_CONSENT: ConsentDocument = {
  kind: 'guardian_consent',
  version: '2026-08-28.2',
  title: 'Guardian consent',
  intro:
    "You're being asked to let {{minor_name}} run a small local service business through Count On Local. Please read each point and check the box to confirm you understand it.",
  items: [
    {
      key: 'earns_money',
      text: '{{minor_name}} will run a business and earn money. They set a price and keep 100% of it. The customer pays Count On Local a small platform fee on top.',
    },
    {
      key: 'guardian_holds_payouts',
      text: 'I hold the money until they turn 18. Because {{minor_name}} is under 18, the payout account is in my name and I receive and oversee the payouts until they turn 18.',
    },
    {
      key: 'address_sharing',
      text: "{{minor_name}} may go to a customer's address to do the work. After someone subscribes, Count On Local shares that customer's service address with {{minor_name}} — and with me — so the work can happen. The work is outdoor, approved tasks only.",
    },
    {
      key: 'messaging',
      text: 'There is an in-app messaging system. {{minor_name}} can exchange messages with adult customers inside Count On Local, tied to a job. It has blocking and reporting and stricter controls for minors — but I understand this communication exists.',
    },
    {
      key: 'no_background_checks',
      text: 'Count On Local does NOT run background checks — on anyone. "Identity verified" means only that a payment identity was confirmed through Stripe. Count On Local vets no one. This is a tool for neighbors who already know and trust each other, and choosing who my teen works with is my responsibility, not Count On Local\'s.',
    },
    {
      key: 'private_by_default',
      text: "{{minor_name}}'s listing is PRIVATE by default. It can be reached only by a link or QR code we choose to share. It will not appear in public search unless I separately sign a Public Listing Consent — and even then it shows only business info, never a home address, school, birth date, or last name.",
    },
    {
      key: 'approved_tasks_only',
      text: 'My teen may only offer approved outdoor tasks — trash cans to the curb, dog walking, yard cleanup, watering, exterior car wash, and similar. They may not use ladders, power tools, or chemicals, may not enter anyone\'s home, and may not do childcare, driving, or any prohibited work.',
    },
    {
      key: 'personally_does_the_work',
      text: 'My teen must personally do the work. Sending someone else in their place (a friend or sibling) is not allowed and can get the account banned.',
    },
    {
      key: 'photos_and_reviews',
      text: 'My teen can add a photo when they finish a job, and customers can leave public reviews. Location data is removed from photos before they are stored, and only my teen, the customer and I can see them; reviews build a public reputation.',
    },
    {
      key: 'revocable',
      text: 'I can withdraw this consent at any time. If I do, the business is paused immediately, no new customers can subscribe, and future charges stop. Work already paid for is handed to support to resolve safely.',
    },
    {
      key: 'not_emergency_service',
      text: "I've read the Safety Center, and I know Count On Local is not an emergency service. In an emergency I will call local emergency services (911). I know how to report a concern.",
    },
  ],
  statement:
    'I am the parent or legal guardian of {{minor_name}}. I have read and understood each point above. I consent to {{minor_name}} operating a business through Count On Local under these terms.',
}

export const PUBLIC_LISTING_CONSENT: ConsentDocument = {
  kind: 'public_listing_consent',
  version: '2026-08-28.1',
  title: 'Public listing consent',
  intro:
    'By default {{minor_name}} can only be reached by a link or QR code you share. This makes their business findable in Count On Local search.',
  items: [
    {
      key: 'understands_default',
      text: 'I understand that by default my teen is reachable only by the link or QR code we share.',
    },
    {
      key: 'chooses_public',
      text: "I choose to make my teen's business listing appear in Count On Local's public search.",
    },
    {
      key: 'business_info_only',
      text: 'I understand the public listing shows business info only — never a home address, school, birth date, last name, or exact schedule.',
    },
    {
      key: 'revocable',
      text: 'I understand I can turn this off at any time, which removes the listing from search.',
    },
  ],
  statement:
    "I consent to {{minor_name}}'s business listing appearing in Count On Local's public search.",
}

export const CUSTOMER_ATTESTATION: ConsentDocument = {
  kind: 'customer_attestation',
  version: '2026-08-28.2',
  title: 'Before you subscribe',
  intro: 'Please read each point and check the box to confirm you understand it.',
  items: [
    { key: 'is_adult', text: 'I am 18 or older.' },
    {
      key: 'no_background_checks',
      text: 'I understand Count On Local does NOT run background checks. I am choosing to hire someone in my neighborhood I know and trust; vetting them is my responsibility.',
    },
    {
      key: 'provider_may_be_minor',
      text: 'I understand the provider may be a teenager (13–17) whose parent or legal guardian has approved their business.',
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
  guardian_consent: GUARDIAN_CONSENT,
  public_listing_consent: PUBLIC_LISTING_CONSENT,
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
