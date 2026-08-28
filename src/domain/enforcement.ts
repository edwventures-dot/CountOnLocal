/**
 * Account consequences.
 *
 * From the owner's legal pass: "No monetary penalties on users -- use
 * account consequences (strike / suspend / ban) instead. Refund the wronged
 * neighbor; remove the jerk."
 *
 * That is a real design constraint and not a preference. Fining a
 * fourteen-year-old for a missed bin collection would be taking money from
 * a child over a $3 service, and the platform holds their payout account.
 * Removing them costs them the work, which is proportionate and does not
 * require anyone to decide what a teenager's bad week is worth in dollars.
 *
 * ## Strikes are a record, not an automatic trigger
 *
 * Three strikes does not suspend anybody by itself. It raises a
 * recommendation to a human, who suspends or does not and writes down why.
 * A counter that acted on its own would suspend a provider whose customer
 * reported three separate visits during the week their grandmother died,
 * and no threshold can tell that apart from a genuine pattern.
 */

export type AccountActionKind = 'strike' | 'suspend' | 'ban' | 'reinstate'

export const ACCOUNT_ACTION_KINDS: readonly AccountActionKind[] = [
  'strike',
  'suspend',
  'ban',
  'reinstate',
]

export function isAccountActionKind(v: unknown): v is AccountActionKind {
  return typeof v === 'string' && (ACCOUNT_ACTION_KINDS as readonly string[]).includes(v)
}

/** Where a human should be asked to look. Never applied automatically. */
export const STRIKES_BEFORE_REVIEW = 3

export type AccountAction = {
  kind: AccountActionKind
  createdAt: string
}

export type AccountStanding = {
  /** Strikes since the last reinstatement. */
  strikes: number
  suspended: boolean
  banned: boolean
  /** True when the strike count has reached the point of asking a human. */
  reviewRecommended: boolean
  /** What the users.status column should say. */
  status: 'active' | 'suspended' | 'closed'
}

/**
 * The current standing, from the history.
 *
 * Derived rather than stored, for the same reason guardian state is a
 * machine rather than a boolean: a flag can be set and then forgotten, and
 * a history cannot disagree with itself.
 *
 * A reinstatement clears a suspension and resets the strike count. It does
 * NOT clear a ban -- a ban is the end of the relationship, and undoing one
 * should mean deliberately creating a new account rather than quietly
 * flipping a row back.
 */
export function accountStanding(actions: readonly AccountAction[]): AccountStanding {
  const ordered = [...actions].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))

  const banned = ordered.some((a) => a.kind === 'ban')

  let strikes = 0
  let suspended = false

  for (const action of ordered) {
    switch (action.kind) {
      case 'strike':
        strikes += 1
        break
      case 'suspend':
        suspended = true
        break
      case 'reinstate':
        suspended = false
        strikes = 0
        break
      case 'ban':
        suspended = true
        break
    }
  }

  return {
    strikes,
    suspended: banned || suspended,
    banned,
    reviewRecommended: !banned && !suspended && strikes >= STRIKES_BEFORE_REVIEW,
    status: banned ? 'closed' : suspended ? 'suspended' : 'active',
  }
}

export type ActionCheck = { ok: true } | { ok: false; message: string }

/**
 * Whether this action makes sense from where the account currently is.
 *
 * Refusing a no-op matters more than it looks: an admin who suspends an
 * already-suspended account and sees "done" reasonably believes they have
 * changed something.
 */
export function checkAccountAction(
  standing: AccountStanding,
  kind: AccountActionKind,
): ActionCheck {
  if (standing.banned && kind !== 'reinstate') {
    return { ok: false, message: 'This account is already banned.' }
  }
  if (standing.banned && kind === 'reinstate') {
    // Stated rather than silently allowed. Reversing a ban is a decision
    // somebody should have to make outside a dropdown.
    return {
      ok: false,
      message: 'A ban cannot be lifted here. Escalate it if it was made in error.',
    }
  }

  switch (kind) {
    case 'suspend':
      return standing.suspended
        ? { ok: false, message: 'This account is already suspended.' }
        : { ok: true }
    case 'reinstate':
      return standing.suspended || standing.strikes > 0
        ? { ok: true }
        : { ok: false, message: 'There is nothing to reinstate.' }
    default:
      return { ok: true }
  }
}

/**
 * What the person is told.
 *
 * Says what happened and what it means for them. It deliberately does not
 * say who reported it -- a suspension notice that names the reporter is a
 * suspension notice that gets somebody shouted at over a fence.
 */
export function standingMessage(standing: AccountStanding): string | null {
  if (standing.banned) {
    return 'This account has been closed and cannot be used. If you think that is wrong, contact support.'
  }
  if (standing.suspended) {
    return 'This account is suspended while we look into a report. You cannot take new work or new customers in the meantime.'
  }
  return null
}
