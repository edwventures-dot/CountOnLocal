import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { AUDIT_ACTIONS } from '@/server/audit'
import { NOTIFICATION_KINDS } from '@/domain/notification'

/**
 * Declared events that nothing emits.
 *
 * This codebase has repeatedly declared a capability and never wired it --
 * a service state nothing could reach, a role nothing granted, a `closed`
 * account status no code path could set, messaging and reviews with no UI.
 * Every one read correctly and did nothing, because absence is silent.
 *
 * Audit actions and notification kinds are the same shape of thing: a name
 * in a union, and either something writes it or nothing does. The
 * difference is that a missing audit row is invisible until somebody needs
 * the log, which is exactly when it is too late to add.
 *
 * ## What this caught when it was written
 *
 * - `account.suspended` was written for every account action, so a
 *   reinstatement was logged as a suspension and "every ban" returned
 *   nothing. Three of four kinds were mislabelled.
 * - `role.granted` was never written by anything, though CLAUDE.md rule 9
 *   lists role changes among the actions that must be audited.
 * - `listing.made_private` was written and `listing.made_public` was not,
 *   so the log recorded a minor's page becoming private and never
 *   recorded it becoming findable.
 *
 * ## Why an allowlist rather than "every name must be used"
 *
 * Some names are genuinely for paths not built yet, and deleting them to
 * satisfy a test would lose the design intent. Naming them here is a
 * deliberate, reviewable statement that the gap is known -- and adding to
 * this list should feel worse than wiring the event up.
 */

const SRC = join(process.cwd(), 'src')

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__') continue
      sourceFiles(full, out)
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full)
    }
  }
  return out
}

/** Every non-test source file, concatenated. */
const allSource = sourceFiles(SRC)
  .filter((f) => !f.endsWith(join('server', 'audit.ts')))
  .filter((f) => !f.endsWith(join('domain', 'notification.ts')))
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n')

/**
 * Audit actions with no writer yet, each with the reason it is not a bug.
 *
 * Shrinking this list is the point. Growing it needs a reason somebody
 * else would accept.
 */
const AUDIT_NOT_YET_WIRED: Readonly<Record<string, string>> = {
  'guardian.flagged_for_review': 'manual_review is a reachable guardian state; nothing routes into it yet',
  'guardian.category_approved': 'per-category guardian approval is designed but not built',
  'guardian.category_revoked': 'per-category guardian approval is designed but not built',
  'payout.account_ready': 'the Connect sync updates columns; it does not yet log the transition',
  'payout.requirements_due': 'same sync, same gap',
  'ledger.credit_written': 'credits are written by the occurrence path, which logs occurrence.credited instead',
  'occurrence.credited': 'the skip/credit path logs its own occurrence actions; this name is unused',
  'occurrence.canceled': 'occurrence cancellation is only reachable through subscription cancellation',
  'occurrence.issue_reported': 'reporting a problem opens an incident and logs incident.opened',
  'review.hidden': 'moderation hides via the report path, which logs review.reported',
  'message.redacted': 'the retention sweep redacts in bulk and logs nothing per message',
}

/**
 * Notification kinds nothing enqueues.
 *
 * Checked by looking for an actual `kind: 'x'` at an enqueue site rather
 * than for the string anywhere in the tree -- a loose substring search
 * reported only three of these as missing, because most of the names also
 * exist as audit actions or appear in comments. Eleven of fifteen were
 * never sent.
 */
const NOTIFICATION_NOT_YET_WIRED: Readonly<Record<string, string>> = {
  'guardian.approved': 'the guardian is told by the consent flow itself, on screen',
  'guardian.revoked': 'revocation is immediate and visible in both dashboards',
  'business.published': 'the provider is looking at the page when it happens',
  'subscription.new_subscriber': 'a provider is not told when somebody subscribes to them',
  'subscription.canceled': 'the customer cancels it themselves and sees the result',
  'occurrence.upcoming': 'no reminder job exists; PRD 20 asks for one',
  'occurrence.completed': 'the customer sees it on their dashboard',
  'occurrence.credited': 'shown as a credit against the next cycle',
  'review.received': 'reviews now exist in the UI; the provider is not told about one',
  'safety.alert': 'incidents are worked from the console, not pushed',
}

describe('audit actions', () => {
  it('has a writer for every action that is not explicitly excused', () => {
    const missing = AUDIT_ACTIONS.filter(
      (action) => !allSource.includes(action) && !(action in AUDIT_NOT_YET_WIRED),
    )
    expect(missing).toEqual([])
  })

  it('does not excuse an action that is in fact written', () => {
    // Keeps the list honest in the other direction: once something is
    // wired, its excuse has to go.
    const stale = Object.keys(AUDIT_NOT_YET_WIRED).filter((a) => allSource.includes(a))
    expect(stale).toEqual([])
  })

  it('excuses only names that are actually declared', () => {
    const unknown = Object.keys(AUDIT_NOT_YET_WIRED).filter(
      (a) => !(AUDIT_ACTIONS as readonly string[]).includes(a),
    )
    expect(unknown).toEqual([])
  })

  it('gives every account action its own name', () => {
    // The specific defect this file was written for: all four kinds wrote
    // account.suspended, so the log said the wrong thing about three of
    // them.
    for (const action of [
      'account.struck',
      'account.suspended',
      'account.banned',
      'account.reinstated',
    ] as const) {
      expect(AUDIT_ACTIONS as readonly string[], action).toContain(action)
      expect(allSource.includes(action), `${action} has no writer`).toBe(true)
    }
  })
})

/**
 * Kinds that appear at an actual enqueue site.
 *
 * `kind: 'x'` inside an enqueueNotification draft. Deliberately narrower
 * than "the string appears somewhere": most of these names are also audit
 * actions, so a substring search says they are wired when nothing sends
 * them.
 */
const enqueuedKinds = new Set(
  [...allSource.matchAll(/kind:\s*'([a-z_]+\.[a-z_]+)'/g)].map((m) => m[1]!),
)

describe('notification kinds', () => {
  it('has a sender for every kind that is not explicitly excused', () => {
    const missing = NOTIFICATION_KINDS.filter(
      (kind) => !enqueuedKinds.has(kind) && !(kind in NOTIFICATION_NOT_YET_WIRED),
    )
    expect(missing).toEqual([])
  })

  it('does not excuse a kind that is in fact sent', () => {
    const stale = Object.keys(NOTIFICATION_NOT_YET_WIRED).filter((k) => enqueuedKinds.has(k))
    expect(stale).toEqual([])
  })

  it('tells a customer when their card is charged or declined', () => {
    // Not excusable. Money leaving somebody's account with no receipt, and
    // a failed payment nobody is told about, are the two that end with a
    // customer discovering it from their bank.
    for (const kind of ['cycle.settled', 'subscription.payment_failed'] as const) {
      expect(enqueuedKinds.has(kind), `${kind} is never sent`).toBe(true)
    }
  })
})
