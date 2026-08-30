/**
 * The public legal documents, as data.
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

/** Kept in one place so three documents cannot disagree about the company. */
const COMPANY = 'EDW Ventures'

const TERMS: LegalDocument = {
  slug: 'terms',
  title: 'Terms of Service',
  summary: 'What Count On Local does, what you agree to, and how money works.',
  status: 'draft',
  version: 'draft-2026-08-30',
  effectiveDate: null,
  sections: [
    {
      id: 'what-this-is',
      heading: 'What Count On Local is',
      body: [
        `Count On Local is a marketplace operated by ${COMPANY}. It lets a person aged 13 or over offer a small, recurring, outdoor service to households near them — putting bins out, walking a dog, tidying a yard — and lets neighbours subscribe to that service.`,
        'We are not the employer of the people who provide services, and we do not perform the work. We run the marketplace: the listings, the scheduling, the payments and the safety controls described here and in the Safety Center.',
        'This is a recurring-service marketplace. There is no open bidding, there are no customer job postings, and there is no way to hire somebody for one-off work except as an addition to a service they already offer.',
      ],
    },
    {
      id: 'who-can-use-it',
      heading: 'Who can use it',
      body: [
        'Customers must be 18 or over. You confirm this when you subscribe. We ask you to confirm it; we do not verify anybody’s age.',
        'Providers must be 13 or over. A provider aged 13 to 17 cannot accept a paying customer until a parent or guardian has connected to their account and given consent, item by item, and signed it with their full legal name.',
        'A provider cannot act as their own guardian. Guardian consent is recorded as a signed, unalterable record.',
      ],
    },
    {
      id: 'prices-and-fees',
      heading: 'Prices, fees and what each side pays',
      body: [
        'The provider sets their own price and keeps all of it. There is no provider fee and no subscription charge for offering a service.',
        'Customers pay a platform fee on top of the provider’s price: 15%, with a minimum of $1.00 per billing cycle. This is the only fee we charge.',
        'A single visit cannot be priced above $50.00. A recurring service is billed per cycle, so several visits in one cycle can total more than that — a $35 weekly service billed every four weeks charges $140. What you will be charged each cycle is shown before you subscribe.',
        'All card payments are handled by Stripe. Card details are entered on Stripe’s own systems and Count On Local never sees or stores a card number.',
      ],
    },
    {
      id: 'subscriptions',
      heading: 'Subscriptions, skipping and cancelling',
      body: [
        'A subscription runs until you pause or cancel it. You can do either at any time from your dashboard.',
        'If a visit does not happen, you are credited for it and the credit reduces the next cycle’s charge. We do not charge a platform fee on a visit that did not happen.',
        'Refunds are issued through the app and can never exceed what was actually charged.',
      ],
    },
    {
      id: 'where-we-operate',
      heading: 'Where Count On Local is available',
      body: [
        'Count On Local operates in the United States. Availability varies by state, and some services may be unavailable in a state even where others are offered.',
        'If we cannot serve your address you will be told when you check it, before you create an account or enter payment details.',
      ],
      needsCounsel:
        'Which states must be restricted at launch, and whether any individual service must be restricted in a state that is otherwise open. The mechanism to enforce this is built and empty — it is data, not code. Per the owner’s response of 2026-08-30, do not describe the platform as Texas-only, and Texas governing-law or company-location language must not imply that users or services are limited to Texas.',
    },
    {
      id: 'acceptable-use',
      heading: 'What is not allowed',
      body: [
        'Providers may only offer services from the list Count On Local publishes. Providers cannot invent a category, and the description a provider writes can never widen what they are approved to do.',
        'A provider must do the work themselves. Sending somebody else in their place is not permitted.',
        'Services that involve entering a customer’s home, childcare, driving, ladders, power tools or chemicals are not offered on this platform.',
        'Using Count On Local to arrange work outside these limits, or to move money for something other than a service on the list, is a breach of these terms.',
      ],
    },
    {
      id: 'suspension',
      heading: 'Suspension and account closure',
      body: [
        'We can suspend or close an account that breaches these terms or that presents a safety risk. Decisions are made by a person, recorded with a written reason, and can be appealed.',
        'We do not charge penalties or fines to any user, in any circumstance.',
        'You can close your own account at any time. Because closure removes your ability to be paid, we ask you to cancel any live subscription and receive any money you are owed first. What happens to your information afterwards is described in the Privacy Notice.',
      ],
    },
    {
      id: 'disputes',
      heading: 'If something goes wrong',
      body: [
        'Report a problem with a visit from your dashboard. Safety concerns can be reported at any time, including from a suspended account.',
        'We will look at what happened, and we can issue a credit or a refund.',
      ],
      needsCounsel:
        'Dispute resolution, arbitration and class-action language, limitation of liability, warranty disclaimers, indemnity, governing law and venue. All of it. Note the multi-state point above before choosing governing-law wording.',
    },
    {
      id: 'changes',
      heading: 'Changes to these terms',
      body: [],
      needsCounsel:
        'How changes are notified, how much notice is given, and what happens to an existing subscription when terms change — particularly where a guardian has consented on behalf of a minor and the terms they consented to have moved.',
    },
  ],
}

const PRIVACY: LegalDocument = {
  slug: 'privacy',
  title: 'Privacy Notice',
  summary: 'What we hold, how long we keep it, and what happens when you ask us to delete it.',
  status: 'draft',
  version: 'draft-2026-08-30',
  effectiveDate: null,
  sections: [
    {
      id: 'principle',
      heading: 'The rule we design against',
      body: [
        'Where a minor’s privacy and somebody’s convenience are in conflict, we choose privacy and tell you we have done so.',
        'A provider’s home address, school, exact age and date of birth are never shown publicly and are never sent to analytics.',
      ],
    },
    {
      id: 'what-we-hold',
      heading: 'What we hold',
      body: [
        'For everybody: an email address, and a password held by our authentication provider in a form we cannot read.',
        'For providers: a first name shown publicly, a date of birth that is never shown to anyone, and for a provider under 18, a guardian’s contact details and their signed consent.',
        'For customers: the service address, any access notes such as a gate code, and a record of what was charged.',
        'Card numbers are never held by us. They go directly to Stripe.',
      ],
    },
    {
      id: 'addresses',
      heading: 'Service addresses and access codes',
      body: [
        'A customer’s service address is shown only to that customer, the provider doing the work, that provider’s connected guardian, and staff handling a specific report. Every time a member of staff views an address, that is recorded with their name and their reason.',
        'Gate and access codes are treated as more sensitive than the address. They appear on the provider’s route screen and nowhere else — never in an email, a notification preview, a log, or an analytics record.',
      ],
    },
    {
      id: 'photos',
      heading: 'Completion photos',
      body: [
        'A provider may add one photo when they finish a visit. It is optional; nothing is blocked if they do not.',
        'Location data and other metadata are removed from the photo before it is stored, not before it is shown. The original is never kept.',
        'Photos are private. They can be seen by the provider, the customer, that provider’s connected guardian, and staff handling a report — nobody else, and there is no shareable link.',
      ],
    },
    {
      id: 'analytics',
      heading: 'Analytics',
      body: [
        'We measure how the product is used. Analytics works from a list of fields that are explicitly permitted, so a new field is excluded until somebody adds it deliberately.',
        'Postal codes sent to analytics are shortened to three digits. Addresses, names, dates of birth and access codes are never sent.',
      ],
    },
    {
      id: 'retention',
      heading: 'How long we keep things',
      body: [
        'Nothing is kept indefinitely. Every kind of record has a period, and a daily job enforces it.',
        'Messages between neighbours: one year. Messages that have been reported or blocked: three years, because they are evidence about somebody’s safety.',
        'Completion photos and service addresses: six months after they are no longer needed — long enough to still evidence a visit if a card payment is disputed months later.',
        'Records of notifications we sent: ninety days.',
        'Financial records, the audit log, safety reports and account decisions: seven years.',
        'Guardian consent: seven years, counted from when the guardian relationship ends rather than from the day it was signed.',
        'Contact details on an account: while the account is in use, and for seven years after it closes or falls completely silent.',
      ],
      needsCounsel:
        'Approve or change these periods. Product’s position is that it prefers defensible retention over aggressive deletion. The seven-year figure is the ordinary US business-records expectation and is the number most likely to be wrong, particularly for money held on behalf of a minor.',
    },
    {
      id: 'deletion',
      heading: 'Deleting your account',
      body: [
        'You can close your account from your account page. Before you confirm, we show you exactly what will be removed and exactly what will be kept, and why.',
        'We do not claim to erase everything, because we cannot and should not. What goes immediately: your contact details, your display name, your addresses including the map coordinates, records of notifications we sent you, your completion photos, and messages you sent.',
        'What stays: financial records, the audit log, safety reports, account decisions, and guardian consent — each for its retention period. These carry an account reference rather than your name, and once your account details are removed they no longer identify you.',
        'Two things we will not do: erase a message that has been reported about your conduct, and close an account while money is still owed to you or a subscription is still running. The second protects you — it is your money, and for a provider aged 13 to 17 it is a minor’s money held in a guardian’s account.',
      ],
      needsCounsel:
        'Whether any applicable deletion right overrides refusing closure while earnings are unpaid or a subscription is live, and whether records created while a provider was a minor need different treatment once that provider turns 18.',
    },
    {
      id: 'sharing',
      heading: 'Who else sees your information',
      body: [
        'Stripe, to take payments and to pay providers. Our email provider, to send you messages. Our hosting and database providers, to run the service.',
        'We do not sell your information.',
      ],
      needsCounsel:
        'The full subprocessor list with each one named, international transfer position, state-specific privacy rights and how they are exercised, cookie disclosure, and the retention wording that pairs with the periods above.',
    },
    {
      id: 'contact',
      heading: 'Contacting us about your information',
      body: [],
      needsCounsel:
        'The contact route for privacy requests, who is responsible, and the response time committed to.',
    },
  ],
}

const SAFETY: LegalDocument = {
  slug: 'safety',
  title: 'Safety Center',
  summary: 'What we check, what we do not check, and how to report a problem.',
  status: 'draft',
  version: 'draft-2026-08-30',
  effectiveDate: null,
  sections: [
    {
      id: 'what-we-do-not-do',
      heading: 'What we do not do',
      body: [
        'We do not run background checks. Not on providers, not on guardians, not on customers, not on anybody.',
        'We do not guarantee anybody’s safety, and we do not describe providers as vetted, screened or approved.',
        'We do not verify anybody’s age. Customers confirm they are 18 or over; that is a statement they make, not something we check.',
        'Where you see “Identity verified” on this platform, it refers only to the identity check Stripe performs before somebody can be paid. It is not a criminal record check and it is not a character reference.',
      ],
    },
    {
      id: 'age-and-guardians',
      heading: 'Age and guardian approval',
      body: [
        'The minimum age to provide a service is 13. This is enforced when the account is created and again in the database, so it cannot be worked around.',
        'A provider aged 13 to 17 cannot take a paying customer until a parent or guardian has connected to their account and consented.',
        'That consent is itemised: eleven separate points, each acknowledged individually, signed with the guardian’s full legal name. We store the exact wording they agreed to, so what was consented to is answerable years later.',
        'A guardian can withdraw consent at any time, and it takes effect immediately.',
        'A provider cannot be their own guardian.',
        'Where you see “Guardian connected”, a guardian has genuinely completed that process. An adult provider with no guardian does not show that badge.',
      ],
    },
    {
      id: 'what-work-is-allowed',
      heading: 'What work is allowed',
      body: [
        'Providers choose from a fixed list of outdoor tasks that Count On Local publishes. They cannot add to it, and the description they write cannot widen what they are allowed to do.',
        'Not offered on this platform: entering a customer’s home, childcare, driving or transport, ladders, power tools, chemicals, or any care involving medication.',
        'Some tasks require a guardian to approve that specific category, over and above their general consent.',
      ],
    },
    {
      id: 'listings',
      heading: 'A young provider’s page is private by default',
      body: [
        'A minor’s service page is reachable by a direct link or a QR code — that is how it is meant to be shared, with neighbours the family chooses.',
        'It is not listed or indexed. Search engines are told not to index it until a guardian separately consents to a public listing, and that consent can be withdrawn.',
        'Even when a page is public it shows business information only. Never a home address, a school, a date of birth, a last name, or the provider’s schedule.',
      ],
    },
    {
      id: 'messaging',
      heading: 'Messaging',
      body: [
        'Messages between a customer and a provider happen inside Count On Local and are tied to a job. There is blocking and reporting, and stricter controls where the provider is a minor.',
        'A connected guardian can see that this messaging exists and can act on it.',
      ],
    },
    {
      id: 'reporting',
      heading: 'Reporting something',
      body: [
        'Anyone can report a safety concern from their dashboard, at any time.',
        'This works even if your account has been suspended. Somebody suspended last week who sees something dangerous today still needs to be able to say so, and the report is usually about somebody else.',
        'Reports are read by people, not by an automated system.',
      ],
    },
    {
      id: 'consequences',
      heading: 'What happens after a report',
      body: [
        'Accounts can receive a strike, be suspended, or be banned. Every one of those is a decision made by a person with a written reason attached, and the history is permanent.',
        'Strikes never suspend an account automatically. A third strike raises it to a human, who decides.',
        'A suspended account cannot take any action on the platform, but can still read its own pages and can still file a safety report.',
        'We never impose a financial penalty on anybody.',
      ],
    },
    {
      id: 'emergency',
      heading: 'If somebody is in danger',
      body: [],
      needsCounsel:
        'Emergency guidance, the mandatory-reporting position and who holds it, escalation route and response commitments, and what we tell a guardian and when. This section must not go out with our words in it — it is the one page somebody reads in the worst moment.',
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
