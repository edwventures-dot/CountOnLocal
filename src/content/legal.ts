/**
 * The public legal documents, as data.
 *
 * ## Rewritten for a product that does not touch money
 *
 * The 2026-09-01 versions described a marketplace: a platform fee, card
 * payments through Stripe, payouts to a guardian's account, providers aged
 * 13 to 17, itemised guardian consent, and an in-person review before a
 * young provider could start. None of that is true here.
 *
 * The open questions shrank with it -- sixteen sections needed counsel on
 * the full product and six do here, because most of them existed to answer
 * one of two questions: what happens when a minor earns money, and what
 * happens when a platform holds it. Neither can be asked of this.
 *
 * ## Why this file exists at all
 *
 * Counsel is drafting Terms, Privacy and the Safety Center. Those documents
 * have to describe behaviour the product actually has -- that is the whole
 * point of marketing/legal/WHAT_THE_PRODUCT_ACTUALLY_DOES.md -- and the
 * failure mode everybody has seen is a Terms page that drifts from the code
 * until neither side knows which is true.
 *
 * So the pages exist now, structured, with the factual half already written
 * from behaviour that has been verified against the real system. What is
 * left is the half only a lawyer can write, and every one of those is
 * marked `needsCounsel` with a note saying what has to be decided. Nothing
 * is invented and nothing is a placeholder pretending to be finished.
 *
 * ## Counsel review, 2026-09-01
 *
 * Revised from the 2026-08-30 draft by outside counsel's review pass, which
 * corrected the legal entity name, removed three overclaims (that we are
 * categorically not the employer, that a provider "keeps all of it", that
 * the customer fee is "the only fee we charge"), reconciled account closure
 * with the rule the code actually enforces, and turned several factual
 * sections into explicit counsel questions.
 *
 * Two of their edits were not adopted as written, both in "Who else sees
 * your information", because they described recipients that do not exist.
 * See the note on that section.
 *
 * ## Nothing here is in force
 *
 * Every document is `draft`. The page renders a banner saying so, and
 * `effectiveDate` stays null until somebody sets it. There is no signup on
 * the public site yet, so nobody can have relied on any of this.
 *
 * Publishing is: replace the counsel sections, set `status: 'in_force'` and
 * an `effectiveDate`, bump `version`. One edit per document.
 *
 * ## The rule for editing factual sections
 *
 * A sentence here is a promise. If it describes what the product does, it
 * must match the code, and the way to check is to exercise the behaviour
 * rather than read the file that implements it -- six capabilities in this
 * codebase were declared and never wired, and every one of them read
 * correctly.
 */

export type LegalSection = {
  id: string
  heading: string
  /** Paragraphs. Rendered in order; no markup, deliberately. */
  body: string[]
  /**
   * Set when the section cannot be finished by engineering. The page shows
   * it as an open question rather than hiding it, so a draft is never
   * mistaken for a finished document.
   */
  needsCounsel?: string
}

export type LegalDocument = {
  slug: 'terms' | 'privacy' | 'safety'
  title: string
  /** One line, shown under the title and used as the meta description. */
  summary: string
  status: 'draft' | 'in_force'
  version: string
  /** Null while the document is a draft. */
  effectiveDate: string | null
  sections: LegalSection[]
}

/**
 * Kept in one place so three documents cannot disagree about the company.
 *
 * Exported because the legal page footer had its own hardcoded copy, which
 * still read "EDW Ventures" after the 2026-09-01 review corrected the entity
 * name everywhere else -- so the page naming the operator in its body named
 * a different company six inches lower. One constant, one name.
 */
export const COMPANY = 'EDW Ventures LLC'

const TERMS: LegalDocument = {
  slug: 'terms',
  title: 'Terms of Service',
  summary: 'What Count On Local does, what you agree to, and what it deliberately does not do.',
  status: 'draft',
  version: 'draft-2026-09-07-free',
  effectiveDate: null,
  sections: [
    {
      id: 'what-this-is',
      heading: 'What Count On Local is',
      body: [
        `Count On Local is software operated by ${COMPANY}. It lets somebody offer a small, recurring, outdoor service to households near them — putting bins out, walking a dog, tidying a yard — and lets neighbours subscribe to that service so both sides know when it is happening.`,
        'It is free. We do not charge providers and we do not charge customers.',
        'We do not perform the work, and we are not part of the arrangement between the two of you. We keep the listing, the schedule and the route.',
        'This is for recurring work. There is no open bidding, there are no customer job postings, and there is no way to hire somebody for one-off work except as an addition to a service they already offer.',
      ],
    },
    {
      id: 'money',
      heading: 'We are not in the middle of the money',
      body: [
        'Count On Local never takes payment and never makes one. There is no card on file, no account balance, and no way to pay somebody through this product.',
        'A provider sets the price, and the page shows it so both of you know what was agreed. Paying it is between you and them — cash, a bank transfer, whatever you both use. What you owe, when you pay it, and what happens if you do not are yours to sort out.',
        'This means there is nothing for us to refund, and no payment we can reverse. If a visit does not happen, the app marks it as skipped so neither of you has to remember, but that is a note about the work rather than a transaction.',
      ],
    },
    {
      id: 'who-can-use-it',
      heading: 'Who can use it',
      body: [
        'You must be 18 or over, whether you are providing a service or subscribing to one. You confirm this when you sign up. We ask you to confirm it; we do not verify anybody’s age, and we do not ask for a date of birth.',
      ],
    },
    {
      id: 'subscriptions',
      heading: 'Subscriptions, skipping and cancelling',
      body: [
        'A subscription runs until you pause or cancel it. You can do either at any time from your dashboard, and it takes effect immediately.',
        'Because nothing is charged, cancelling costs nothing and requires no notice. Any visits still on the schedule are removed and both sides can see that they have been.',
      ],
    },
    {
      id: 'where-we-operate',
      heading: 'Where Count On Local is available',
      body: [
        'The United States. Whether a particular address is covered depends on the provider’s own service area, which is theirs to set.',
      ],
    },
    {
      id: 'acceptable-use',
      heading: 'What may be offered',
      body: [
        'Providers choose from a fixed list of outdoor services that we publish. They cannot add a category, and the description they write cannot widen what the service actually is.',
        'Services that involve entering a customer’s home, childcare, driving, ladders, power tools or chemicals are not offered on this platform.',
        'Using Count On Local to arrange work outside these limits is a breach of these terms.',
      ],
    },
    {
      id: 'suspension',
      heading: 'Suspension and closing your account',
      body: [
        'We can suspend or close an account that breaches these terms or that presents a safety risk. Decisions are made by a person, recorded with a written reason, and can be appealed.',
        'We do not charge penalties or fines to any user, in any circumstance. We could not: we have no way to take money from you.',
        'You can close your account from your account page. What happens to your information afterwards is described in the Privacy Notice.',
      ],
    },
    {
      id: 'disputes',
      heading: 'If something goes wrong',
      body: [
        'If a visit was missed, done badly, or something was damaged, that is between you and the person you arranged it with. We are not a party to it and we cannot compensate either of you.',
        'What we can do is act on a safety report, and we will. See the Safety Center.',
      ],
      needsCounsel:
        'Dispute resolution, arbitration and class-action language, limitation of liability, warranty disclaimers, indemnity, governing law and venue. ' +
        'This is a materially smaller question than it was on the full product: Count On Local does not take payment, does not pay anybody, does not employ anybody, and has no users under 18. What remains is an ordinary software product that introduces adults to each other and keeps a schedule for them — closer to a listings site than to a marketplace. ' +
        'Note in particular that there is no transaction to arbitrate. Any dispute about the work itself is between two neighbours who arranged it privately, and the operator has no record of what was paid because no payment passes through the product.',
    },
    {
      id: 'changes',
      heading: 'Changes to these terms',
      body: [],
      needsCounsel:
        'How changes are notified, how much notice is given, and what happens to a running subscription when the terms change. Nothing is charged, so there is no billing consequence to a change — the question is only about notice and continued use.',
    },
  ],
}

const PRIVACY: LegalDocument = {
  slug: 'privacy',
  title: 'Privacy Notice',
  summary: 'What we hold, how long we keep it, and what happens when you ask us to delete it.',
  status: 'draft',
  version: 'draft-2026-09-07-free',
  effectiveDate: null,
  sections: [
    {
      id: 'principle',
      heading: 'The rule we design against',
      body: [
        'We collect the least that makes the product work, and where holding something would be convenient for us but revealing for you, we do not hold it.',
        'The clearest example is age. We need to know you are an adult, so we ask you to confirm it — and we do not ask for your date of birth, because a birth date would answer the same question while telling us something we would then have to protect.',
      ],
    },
    {
      id: 'what-we-hold',
      heading: 'What we hold',
      body: [
        'For everybody: an email address, and a password held by our hosting provider in a form we cannot read.',
        'For providers: a first name, shown publicly. Never a last name.',
        'For customers: the service address, and any access notes such as a gate code.',
        'We do not hold card numbers, bank details, tax identifiers or dates of birth. None of them exist anywhere in this product, because nothing here takes payment.',
      ],
    },
    {
      id: 'addresses',
      heading: 'Service addresses and access codes',
      body: [
        'A customer’s service address is shown only to that customer, the provider doing the work, and staff handling a specific report. Every time a member of staff views an address, that is recorded with their name and their reason.',
        'Gate and access codes are treated as more sensitive than the address. They appear on the provider’s route screen and nowhere else — never in an email, a notification preview, a log, or an analytics record.',
      ],
    },
    {
      id: 'photos',
      heading: 'Completion photos',
      body: [
        'A provider may add one photo when they finish a visit. It is optional; nothing is blocked if they do not.',
        'Location data and other metadata are removed from the photo before it is stored, not before it is shown. The original is never kept.',
        'Photos are private. They can be seen by the provider, the customer, and staff handling a report — nobody else, and there is no shareable link.',
      ],
    },
    {
      id: 'analytics',
      heading: 'Analytics',
      body: [
        'We measure how the product is used. Analytics works from a list of fields that are explicitly permitted, so a new field is excluded until somebody adds it deliberately.',
        'Postal codes sent to analytics are shortened to three digits. Addresses, names and access codes are never sent.',
        'We do not sell your information, and we do not currently send it to an analytics provider at all.',
      ],
    },
    {
      id: 'retention',
      heading: 'How long we keep things',
      body: [
        'Nothing is kept indefinitely. Every kind of record has a period, and a daily job enforces it.',
        'Messages between neighbours: one year. Messages that have been reported or blocked: three years, because they are evidence about somebody’s safety.',
        'Completion photos and service addresses: six months after they are no longer needed.',
        'Records of notifications we sent: ninety days.',
        'The audit log, safety reports and account decisions: seven years.',
        'Contact details on an account: while the account is in use, and for seven years after it closes or falls completely silent.',
      ],
      needsCounsel:
        'Approve or change these periods. Product’s position is that it prefers defensible retention over aggressive deletion. ' +
        'Two things that shortened this list are worth knowing: there are no financial records, because no money moves through the product, and there is no guardian consent, because there are no users under 18. The seven-year figure that remains is the ordinary US business-records expectation applied to safety and account decisions rather than to money.',
    },
    {
      id: 'deletion',
      heading: 'Deleting your account',
      body: [
        'You can close your account from your account page. Before you confirm, we show you exactly what will be removed and exactly what will be kept, and why.',
        'We do not claim to erase everything, because we cannot and should not. What goes immediately: your contact details, your display name, your addresses including the map coordinates, records of notifications we sent you, your completion photos, and messages you sent.',
        'What stays: the audit log, safety reports and account decisions, each for its retention period. Direct account identifiers are removed where possible, while retained records remain associated with an internal account reference.',
        'One thing we will not do: erase a message that has been reported about your conduct. Somebody else’s safety report is not yours to delete.',
      ],
      needsCounsel:
        'Whether any applicable deletion right overrides refusing to erase a message that is evidence in somebody else’s safety report, and whether retained records remain personal information under applicable law once direct identifiers are removed.',
    },
    {
      id: 'sharing',
      heading: 'Who else sees your information',
      body: [
        'Our email provider, to send you messages. Our hosting provider, which also runs our database and holds the passwords used to sign in.',
        'That is the whole list. There is no payment processor, because nothing is paid through this product.',
      ],
      needsCounsel:
        'The full subprocessor list with each one named, international transfer position, state-specific privacy rights and how they are exercised, and cookie/tracking disclosure. ' +
        'The list is deliberately short and the claim is checkable: a test fails if a second analytics implementation appears while the notice still denies having one. If a payment processor or an advertising network is ever added, this section and the sentences denying them must change in the same commit.',
    },
    {
      id: 'contact',
      heading: 'Contacting us about your information',
      body: [],
      needsCounsel:
        `The ${COMPANY} contact route for privacy requests, who is responsible, required identity-verification process, and the response timing required or promised.`,
    },
  ],
}

const SAFETY: LegalDocument = {
  slug: 'safety',
  title: 'Safety Center',
  summary: 'What we check, what we do not check, and how to report a problem.',
  status: 'draft',
  version: 'draft-2026-09-07-free',
  effectiveDate: null,
  sections: [
    {
      id: 'what-we-do-not-do',
      heading: 'What we do not do',
      body: [
        'We do not run background checks. Not on providers, not on customers, not on anybody.',
        'We do not guarantee anybody’s safety, and we do not describe providers as vetted, screened or approved.',
        'We do not verify anybody’s age. Everybody confirms they are 18 or over; that is a statement they make, not something we check.',
        'We do not verify anybody’s identity. Nothing on this platform means we have confirmed a person is who they say they are.',
        'You are choosing to let somebody come to your home, or to go to somebody else’s. Deciding whether that is a good idea is yours.',
      ],
    },
    {
      id: 'who-can-provide',
      heading: 'Everybody here is an adult',
      body: [
        'The minimum age is 18, for providers and customers alike. Nobody under 18 can hold an account.',
        'We ask you to confirm your age rather than asking for your date of birth, so we hold the answer and not the detail.',
      ],
    },
    {
      id: 'what-work-is-allowed',
      heading: 'What work is allowed',
      body: [
        'Providers choose from a fixed list of outdoor tasks that Count On Local publishes. They cannot add to it, and the description they write cannot widen what they are allowed to do.',
        'Not offered on this platform: entering a customer’s home, childcare, driving or transport, ladders, power tools, chemicals, or any care involving medication.',
      ],
    },
    {
      id: 'messaging',
      heading: 'Messaging',
      body: [
        'Messages between a customer and a provider happen inside Count On Local and are tied to a job. There is blocking and reporting.',
      ],
    },
    {
      id: 'reporting',
      heading: 'Reporting something',
      body: [
        'Anyone can report a safety concern from their dashboard, at any time.',
        'This works even if your account has been suspended. Somebody suspended last week who sees something dangerous today still needs to be able to say so, and the report is usually about somebody else.',
        `Reports are read by people at ${COMPANY}, not by an automated system.`,
      ],
    },
    {
      id: 'consequences',
      heading: 'What happens after a report',
      body: [
        'Accounts can receive a strike, be suspended, or be banned. Every one of those is a decision made by a person with a written reason attached, and the decision history is retained as described in our Privacy Notice.',
        'Strikes never suspend an account automatically. A third strike raises it to a human, who decides.',
        'A suspended account cannot take any action on the platform, but can still read its own pages and can still file a safety report.',
        'We never impose a financial penalty on anybody, and we have no way to.',
      ],
    },
    {
      id: 'insurance',
      heading: 'Insurance',
      body: [],
      needsCounsel:
        `${COMPANY} currently carries no business or liability insurance covering Count On Local. Advise whether coverage is legally required or commercially prudent, what limits and types are appropriate for a free product that introduces adults to each other for household work, and whether users should receive an explicit no-platform-insurance disclosure.`,
    },
    {
      id: 'emergency',
      heading: 'If somebody is in danger',
      body: [],
      needsCounsel:
        'Emergency guidance, the escalation route, and what we commit to in response. ' +
        'Smaller than it was, because there are no minors and therefore no mandatory-reporting question and no guardian to notify — but this is still the one page somebody reads in the worst moment of their day, and it must not go out with our words in it.',
    },
  ],
}

export const LEGAL_DOCUMENTS: readonly LegalDocument[] = [TERMS, PRIVACY, SAFETY]

export function legalDocument(slug: string): LegalDocument | undefined {
  return LEGAL_DOCUMENTS.find((d) => d.slug === slug)
}

/** True while any document is still a draft, which gates the footer wording. */
export function anyDraft(): boolean {
  return LEGAL_DOCUMENTS.some((d) => d.status === 'draft')
}
