/**
 * Mail the outbox gave up on.
 *
 * Migration 0020 defines the `dead` state as "gave up; a human should
 * look", and nothing let a human look. The rows sat in a table with no
 * screen, which is the same shape of gap as an endpoint with no caller and
 * an audit action with no writer.
 *
 * ## Why this is not merely tidy
 *
 * Every dead row found when this was written was a
 * `guardian.approval_requested`. In production that means a guardian
 * invitation never arrived: the minor cannot take a paying customer, their
 * page says it is waiting for a guardian, and the only record of why is a
 * row nobody reads. The provider is a teenager who concludes the product
 * is broken, and they are not wrong.
 *
 * ## What staff see, and what they do not
 *
 * Not the address. The domain is enough to tell a typo from an outage --
 * "invalid `to` field" on gmial.com is a different problem from a 500 from
 * the provider -- and a console listing every customer's email address is
 * a directory nobody asked for. SAFETY_TRUST_POLICY 3 keeps the customer
 * side private, and an operational screen is not an exception to it.
 *
 * The recipient's user id is shown, so somebody who genuinely needs the
 * address can go and read it through the path that audits doing so.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'

type Db = SupabaseClient<Database>

export type DeadNotice = {
  id: string
  kind: string
  /** Recipient's user id, or null for an invitation to somebody with no account. */
  recipientUserId: string | null
  /** Domain only. See the note above. */
  destinationDomain: string
  attempts: number
  lastError: string | null
  queuedAt: string
}

/**
 * Everything after the @, with the person removed.
 *
 * Returns a placeholder rather than the raw value when there is no @ at
 * all: a malformed destination is exactly the case worth surfacing, and
 * printing it whole would put whatever junk is in that column on screen.
 */
export function destinationDomain(destination: string): string {
  const at = destination.lastIndexOf('@')
  if (at < 0 || at === destination.length - 1) return '(not an address)'
  return destination.slice(at + 1).toLowerCase()
}

/**
 * Undelivered mail, newest first.
 *
 * Capped, because this is a screen somebody scans rather than a report they
 * export -- and a console that tries to render ten thousand rows is a
 * console that stops being opened.
 */
export async function listUndelivered(db: Db, limit = 50): Promise<DeadNotice[]> {
  const { data, error } = await db
    .from('notifications')
    .select('id, kind, recipient_user_id, destination, attempts, last_error, created_at')
    .eq('state', 'dead')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    console.error('[mail] could not list undelivered', error.message)
    return []
  }

  return (data ?? []).map((row) => ({
    id: row.id,
    kind: row.kind,
    recipientUserId: row.recipient_user_id,
    destinationDomain: destinationDomain(row.destination),
    attempts: row.attempts,
    lastError: row.last_error,
    queuedAt: row.created_at,
  }))
}

export type RetryResult =
  | { ok: true; queued: number }
  | { ok: false; code: 'NOT_AUTHORIZED' | 'WRITE_FAILED'; message: string }

/**
 * Puts a dead notice back in the queue.
 *
 * For the case where the cause was outside the message: a provider outage,
 * a domain that has since been verified, a sending key that was wrong.
 * Retrying a genuinely invalid address just kills it again, which is
 * cheap and honest.
 *
 * The attempt count is reset so the backoff starts over rather than the
 * row dying again on its next attempt. The original failure stays in
 * last_error until a new one replaces it, so a retry that fails the same
 * way is not mistaken for a fresh problem.
 */
export async function retryUndelivered(args: {
  db: Db
  ids: string[]
  now: Date
}): Promise<RetryResult> {
  if (args.ids.length === 0) return { ok: true, queued: 0 }

  const { data, error } = await args.db
    .from('notifications')
    .update({
      state: 'pending',
      attempts: 0,
      next_attempt_at: args.now.toISOString(),
    })
    .in('id', args.ids)
    // Only dead ones. Resetting something mid-flight would send it twice.
    .eq('state', 'dead')
    .select('id')

  if (error) {
    console.error('[mail] retry failed', error.message)
    return { ok: false, code: 'WRITE_FAILED', message: 'Could not requeue that.' }
  }

  return { ok: true, queued: (data ?? []).length }
}
