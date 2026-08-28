/**
 * How long each kind of record is kept, and what a deletion request does.
 *
 * TECHNICAL_SPEC section 23: "Create configurable retention policy by
 * entity class. Safety/financial records may need longer retention than
 * ordinary drafts/messages. Do not invent indefinite retention by default.
 * User deletion must honor legal/financial retention while removing or
 * de-identifying data that no longer needs to be tied to the user."
 *
 * ## THE NUMBERS BELOW ARE PROPOSALS, NOT LEGAL ADVICE
 *
 * Each period carries a stated reason so counsel can agree with it or
 * overrule it with something concrete to argue against. What is NOT a
 * proposal is the shape: every class has a finite period, nothing defaults
 * to forever, and a deletion request cannot erase the financial or safety
 * record.
 *
 * A developer changing a number here is changing a legal commitment. That
 * is deliberate -- it should be one obvious edit in one file, visible in a
 * diff, rather than a constant buried in a job.
 *
 * ## Three different questions, kept apart
 *
 * These get conflated constantly, and conflating them produces a policy
 * that cannot be implemented:
 *
 *   1. `atExpiry` -- what happens when the retention period runs out.
 *      Happens to everybody, on a schedule, with nobody asking.
 *   2. `onRequest` -- whether a deletion request brings that forward.
 *      `erase` applies the class's `atExpiry` treatment immediately;
 *      `retain` leaves it to age out on its own clock and not before.
 *   3. `mechanism` -- whether the class holds personal data in its own
 *      columns, or only a reference to the account row.
 *
 * A flagged message shows why (1) and (2) are separate. It expires after
 * three years, but a deletion request does not touch it -- otherwise the
 * way to erase a report about your conduct is to close your account, which
 * makes reporting worthless.
 *
 * The ledger shows why (3) matters. Nothing in a ledger entry names
 * anybody; it carries a user id and an amount. De-identifying it is not a
 * separate sweep and never could be -- it happens the moment the account
 * row those ids point at stops naming a person. Claiming a sweep exists
 * for it would be describing work no code does.
 *
 * ## Why deletion mostly means de-identification
 *
 * A person asking to be forgotten cannot take the money with them. The
 * ledger has to keep balancing, an incident about a minor has to remain
 * investigable, and a guardian's consent has to remain provable -- if the
 * consent record could be deleted, "did a parent agree to this" becomes
 * unanswerable exactly when somebody needs the answer.
 *
 * The database already refuses the alternative, and did before this file
 * existed: `consent_records.signer_user_id` is `on delete restrict`, so
 * a row in `users` cannot be deleted once that person has signed anything.
 * Hard deletion of an account was never actually available.
 *
 * The same constraint decides the shape of several rules below.
 * `subscriptions.service_address_id` is `on delete restrict` and
 * subscriptions are a financial record kept for years, so a customer
 * address CANNOT be deleted at six months however much one would prefer
 * it. It is emptied instead: the row survives to hold the foreign key,
 * and the street it names does not.
 *
 * So closure means the account stops naming a person -- contact details
 * and display names are replaced, the row and its references stay -- and
 * the retained classes age out on their own clocks afterwards.
 */

export type RetentionClass =
  | 'message_ordinary'
  | 'message_flagged'
  | 'completion_photo'
  | 'customer_address'
  | 'notification'
  | 'ledger_entry'
  | 'audit_log'
  | 'consent_record'
  | 'incident'
  | 'account_action'

/** What happens when the retention period runs out. */
export type AtExpiry =
  /** The row, or the part of it with content, goes. */
  | 'delete'
  /** The row stays; the parts naming a person are replaced. */
  | 'de_identify'

/** Whether a deletion request brings the expiry treatment forward. */
export type OnRequest =
  /** The `atExpiry` treatment is applied immediately on closure. */
  | 'erase'
  /** Left alone. It ages out on its own clock and not before. */
  | 'retain'

/** Where the personal data in a class actually lives. */
export type Mechanism =
  /** In this table's own columns. A sweep has something to do. */
  | 'own_columns'
  /**
   * Only as a reference to the account row. De-identification happens when
   * that row stops naming a person, and no separate sweep exists or could.
   */
  | 'via_account'

export type RetentionRule = {
  days: number
  atExpiry: AtExpiry
  onRequest: OnRequest
  mechanism: Mechanism
  /** Why this number. Counsel needs something to disagree with. */
  reason: string
  /** What the clock counts from, in words. */
  clock: string
  /** Only for `retain`: why a person cannot have this on request. */
  retainedBecause?: string
}

const YEAR = 365

/**
 * A card network dispute can arrive up to about 120 days after a charge.
 * Anything that evidences a disputed visit has to outlive that window, or
 * the platform is defending a chargeback with nothing in hand.
 */
export const CHARGEBACK_WINDOW_DAYS = 120

/**
 * Seven years, used for financial and safety records.
 *
 * The ordinary US business-records expectation. Counsel should confirm it
 * against the actual obligation for a marketplace holding money on behalf
 * of minors, which may well be longer for the money and is the single most
 * likely number in this file to be wrong.
 */
export const LONG_RETENTION_DAYS = YEAR * 7

export const RETENTION: Readonly<Record<RetentionClass, RetentionRule>> = {
  message_ordinary: {
    days: YEAR,
    atExpiry: 'de_identify',
    onRequest: 'erase',
    mechanism: 'own_columns',
    clock: 'the message being sent',
    reason:
      'Ordinary conversation between neighbours. Long enough to settle a disagreement about what was arranged, short enough not to accumulate years of a teenager’s messages.',
  },
  message_flagged: {
    days: YEAR * 3,
    atExpiry: 'de_identify',
    onRequest: 'retain',
    mechanism: 'own_columns',
    clock: 'the message being sent',
    reason:
      'Reported or blocked messages are evidence about a minor’s safety. The people who may need them are a guardian, trust and safety, or eventually somebody outside the company, and none of those move quickly.',
    retainedBecause:
      'Otherwise the way to erase a report about your conduct is to close your account.',
  },
  completion_photo: {
    days: 180,
    atExpiry: 'delete',
    onRequest: 'erase',
    mechanism: 'own_columns',
    clock: 'the visit',
    reason: `Photographs taken outside somebody’s home. Held past the ${CHARGEBACK_WINDOW_DAYS}-day chargeback window so a disputed visit can still be evidenced, and not much past it.`,
  },
  customer_address: {
    days: 180,
    // Emptied, not deleted: subscriptions.service_address_id is
    // `on delete restrict` and a subscription outlives the address by
    // years, so the row has to survive to hold the key.
    atExpiry: 'de_identify',
    onRequest: 'erase',
    mechanism: 'own_columns',
    clock: 'the last subscription at that address ending',
    reason:
      'Needed to run the route and to defend a disputed visit. Once no live subscription uses it and the chargeback window has closed, it is a stranger’s home address held for no reason.',
  },
  notification: {
    days: 90,
    atExpiry: 'delete',
    onRequest: 'erase',
    mechanism: 'own_columns',
    clock: 'the notification being queued',
    reason:
      'Operational records of what was sent. Useful for answering "did they ever get the email" and worthless after a season.',
  },
  ledger_entry: {
    days: LONG_RETENTION_DAYS,
    atExpiry: 'de_identify',
    onRequest: 'retain',
    mechanism: 'via_account',
    clock: 'the entry being written',
    reason:
      'Financial records, including money held on behalf of a minor and paid to a guardian. Kept as long as the books must be reconstructable.',
    retainedBecause:
      'The ledger balances to zero on every movement. Removing one side of a pair breaks that for every other party to it.',
  },
  audit_log: {
    days: LONG_RETENTION_DAYS,
    atExpiry: 'de_identify',
    onRequest: 'retain',
    mechanism: 'via_account',
    clock: 'the action',
    reason:
      'Who did what to whom, including every staff action taken about a minor and every time a customer’s address was read.',
    retainedBecause:
      'Deleting these on request would let somebody erase the record of decisions made about them, which is the opposite of what an audit log is for.',
  },
  consent_record: {
    days: LONG_RETENTION_DAYS,
    atExpiry: 'de_identify',
    onRequest: 'retain',
    // The typed signature is in this table's own column, so unlike the
    // ledger there is genuinely something to redact here.
    mechanism: 'own_columns',
    clock: 'the guardian relationship ending, not the day it was signed',
    reason:
      'Proof a parent agreed. Append-only by design: revocation is a new row and the original is never touched.',
    retainedBecause:
      '"Did a guardian consent to this" has to stay answerable after the relationship ends, and the person best placed to want it unanswerable is the one who would ask.',
  },
  incident: {
    days: LONG_RETENTION_DAYS,
    atExpiry: 'de_identify',
    onRequest: 'retain',
    mechanism: 'via_account',
    clock: 'the incident being resolved',
    reason:
      'Safety reports. A pattern visible only across several years is exactly the pattern these exist to surface.',
    retainedBecause: 'A person who was reported must not be able to remove the report.',
  },
  account_action: {
    days: LONG_RETENTION_DAYS,
    atExpiry: 'de_identify',
    onRequest: 'retain',
    mechanism: 'via_account',
    clock: 'the action',
    reason: 'Strikes, suspensions, bans and reinstatements, with the reason each was given.',
    retainedBecause: 'A banned account that can erase its own ban is not banned.',
  },
}

/**
 * The classes a retention sweep actually has work to do for.
 *
 * Used by the job to decide what to visit, and by the tests to catch the
 * failure this project has hit six times: a class listed in the policy
 * that no code ever touches, with nothing failing because absence is
 * silent.
 */
export function sweptClasses(): RetentionClass[] {
  const classes = Object.keys(RETENTION) as RetentionClass[]
  return classes.filter((c) => RETENTION[c].mechanism === 'own_columns')
}

/** Nothing is kept forever. Asserted rather than hoped for. */
export function hasFiniteRetention(rule: RetentionRule): boolean {
  return Number.isFinite(rule.days) && rule.days > 0
}

export type DeletionEffect = {
  /** Acted on the moment the account closes. */
  erasedNow: RetentionClass[]
  /** Left to age out, with the reason it could not be erased. */
  retained: Array<{ class: RetentionClass; days: number; because: string }>
}

/**
 * What a deletion request actually does, as data.
 *
 * Returned rather than described so the answer shown to the person and the
 * work the job performs come from the same place. Telling somebody their
 * data is gone while a job keeps seven years of it would be exactly the
 * kind of unearned claim this codebase refuses everywhere else.
 */
export function deletionEffect(): DeletionEffect {
  const classes = Object.keys(RETENTION) as RetentionClass[]
  return {
    erasedNow: classes.filter((c) => RETENTION[c].onRequest === 'erase'),
    retained: classes
      .filter((c) => RETENTION[c].onRequest === 'retain')
      .map((c) => ({
        class: c,
        days: RETENTION[c].days,
        because: RETENTION[c].retainedBecause ?? RETENTION[c].reason,
      })),
  }
}

/**
 * The placeholder a de-identified field is set to.
 *
 * Deliberately not an empty string. A blank reads as "we never had this",
 * and the truth is that we had it and took it out. Somebody reading a
 * seven-year-old audit row should be able to tell those apart.
 */
export const REDACTED = '[removed on retention schedule]'

/**
 * The address a closed account's email is replaced with.
 *
 * `users` requires an email or a phone (`users_need_a_contact`) and both
 * are unique, so closure cannot simply null them out. This produces a
 * unique value at a reserved TLD that can never receive mail and can never
 * collide with a real address.
 *
 * RFC 2606 reserves `.invalid` precisely so it can never be registered.
 */
export function tombstoneEmail(userId: string): string {
  return `closed+${userId}@account.invalid`
}

/** Whether something has passed its retention period. */
export function isExpired(args: { clockStart: Date; rule: RetentionRule; now: Date }): boolean {
  const ageDays = (args.now.getTime() - args.clockStart.getTime()) / 86_400_000
  return ageDays >= args.rule.days
}

/** The cutoff before which rows of this class have expired. */
export function cutoffFor(args: { rule: RetentionRule; now: Date }): Date {
  return new Date(args.now.getTime() - args.rule.days * 86_400_000)
}
