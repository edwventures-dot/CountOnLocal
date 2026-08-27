/**
 * Writing to the outbox, and emptying it.
 *
 * TECHNICAL_SPEC section 12: the business transaction writes a row, a
 * worker sends it. The point is that an HTTP request which succeeds cannot
 * lose the message -- a guardian invitation that returns 200 and never
 * arrives leaves the provider believing their guardian was asked and the
 * guardian hearing nothing at all.
 *
 * ## The sender is behind an interface
 *
 * Same arrangement as the geocoder and the charger, for the same reason:
 * the retry logic, the backoff and the give-up rule are the interesting
 * parts and they should be exercisable without a network call. No email
 * provider is configured yet, so the default sender refuses loudly rather
 * than pretending -- a notification that silently vanishes is exactly the
 * failure this module exists to prevent.
 *
 * ## Claiming
 *
 * A worker claims a row by moving it to `sending` with a conditional update
 * that only matches rows still in a claimable state. Two workers racing on
 * the same row means one update matches and the other matches nothing, so
 * the row is sent once without a lock or a queue.
 */

import {
  backoffSeconds,
  checkDraft,
  isNotificationKind,
  shouldGiveUp,
  UNSUPPRESSIBLE_KINDS,
  type DraftNotification,
  type NotificationKind,
} from '@/domain/notification'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'

type Db = SupabaseClient<Database>

// ---------------------------------------------------------------------------
// The sender
// ---------------------------------------------------------------------------

export type SendRequest = {
  /**
   * The outbox row. Unique per queued message, which is what a provider's
   * idempotency key needs to be -- see the note in resendNotifier.
   */
  id: string
  channel: 'email' | 'sms' | 'push'
  destination: string
  subject: string | null
  preview: string | null
  kind: string
  payload: Record<string, unknown>
}

export type SendResult =
  | { ok: true; providerMessageId?: string | undefined }
  /** Retryable: the provider was unreachable or busy. */
  | { ok: false; retryable: true; message: string }
  /** Permanent: a malformed address, a hard bounce, an unroutable number. */
  | { ok: false; retryable: false; message: string }

export interface Notifier {
  send(request: SendRequest): Promise<SendResult>
}

/**
 * What runs until an email provider is chosen.
 *
 * Refuses, permanently, and says why. The alternative -- returning ok and
 * dropping the message -- would make the outbox look healthy while nothing
 * arrived, which is worse than an obviously unconfigured system.
 */
export class UnconfiguredNotifier implements Notifier {
  async send(): Promise<SendResult> {
    return {
      ok: false,
      retryable: false,
      message:
        'No notification provider is configured. Set one up (Resend, Postmark, SES) and register it with setNotifier().',
    }
  }
}

/** Records what it was asked to send and answers however the test says. */
export class StubNotifier implements Notifier {
  readonly sent: SendRequest[] = []
  private outcome: SendResult | ((r: SendRequest) => SendResult) = { ok: true }

  setOutcome(outcome: SendResult | ((r: SendRequest) => SendResult)): void {
    this.outcome = outcome
  }

  async send(request: SendRequest): Promise<SendResult> {
    this.sent.push(request)
    return typeof this.outcome === 'function' ? this.outcome(request) : this.outcome
  }
}

let current: Notifier | undefined

export function getNotifier(): Notifier {
  if (!current) current = new UnconfiguredNotifier()
  return current
}

export function setNotifier(n: Notifier): void {
  current = n
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export type EnqueueResult =
  | { ok: true; id: string; duplicate: boolean }
  | { ok: false; code: 'INVALID' | 'WRITE_FAILED'; message: string }

const UNIQUE_VIOLATION = '23505'

/**
 * Puts one notification in the outbox.
 *
 * The draft is checked against domain/notification.ts first, so an address
 * or a gate code in a subject line fails here rather than arriving on
 * somebody's lock screen. That check refuses rather than sanitising:
 * quietly stripping the address would hide whichever caller put it there.
 *
 * `idempotencyKey` makes a repeated event a no-op. Two settlement runs for
 * one cycle must not send two receipts.
 */
export async function enqueueNotification(args: {
  db: Db
  draft: DraftNotification
  recipientUserId?: string | null
  idempotencyKey?: string | undefined
  /** The app's clock. See the note on next_attempt_at below. */
  now?: Date
}): Promise<EnqueueResult> {
  const { db, draft } = args
  const now = args.now ?? new Date()

  if (!isNotificationKind(draft.kind)) {
    return { ok: false, code: 'INVALID', message: `Unknown notification kind: ${draft.kind}` }
  }

  const check = checkDraft(draft)
  if (!check.ok) {
    // Loud. A caller that tried to put an address in a preview has a bug,
    // and it should be found now rather than in a support ticket.
    console.error('[notifications] refused a draft', {
      kind: draft.kind,
      field: check.field,
      code: check.code,
    })
    return { ok: false, code: 'INVALID', message: check.message }
  }

  const { data, error } = await db
    .from('notifications')
    .insert({
      kind: draft.kind,
      channel: draft.channel,
      destination: draft.destination.trim(),
      subject: draft.subject ?? null,
      preview: draft.preview ?? null,
      payload: draft.payload ?? {},
      recipient_user_id: args.recipientUserId ?? null,
      idempotency_key: args.idempotencyKey ?? null,
      // Stamped from the app's clock, not left to the column default.
      //
      // dispatchNotifications claims rows whose next_attempt_at has passed,
      // comparing against a Date from the app. The retry path already sets
      // this field the same way. Letting the initial insert fall through to
      // the database's now() instead put the two halves of one field on two
      // different clocks -- and the database here runs about a second ahead,
      // so a row enqueued and dispatched in the same job run was invisible
      // to the dispatcher and waited for the next one.
      //
      // That is not hypothetical: the daily job settles and then notifies in
      // the same invocation precisely so receipts leave immediately, and on
      // a once-a-day schedule the skew turned "immediately" into tomorrow.
      next_attempt_at: now.toISOString(),
    })
    .select('id')
    .single()

  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      // Already queued by an earlier run of the same event.
      const { data: existing } = await db
        .from('notifications')
        .select('id')
        .eq('idempotency_key', args.idempotencyKey!)
        .maybeSingle()
      return { ok: true, id: existing?.id ?? '', duplicate: true }
    }
    console.error('[notifications] enqueue failed', error.message)
    return { ok: false, code: 'WRITE_FAILED', message: error.message }
  }

  return { ok: true, id: data!.id, duplicate: false }
}

/**
 * Marks a notification as deliberately not sent.
 *
 * PRD section 20 makes email the mandatory transactional baseline and
 * requires explicit consent for marketing SMS. Some kinds cannot be
 * suppressed at all: a payment failure or a safety alert is not a
 * preference, and turning it off would leave somebody's card broken or a
 * guardian uninformed about something that matters.
 */
export async function suppressNotification(args: {
  db: Db
  id: string
  kind: NotificationKind
  reason: string
}): Promise<{ ok: boolean; refused?: boolean }> {
  if (UNSUPPRESSIBLE_KINDS.has(args.kind)) {
    console.warn('[notifications] refused to suppress a mandatory kind', { kind: args.kind })
    return { ok: false, refused: true }
  }

  const { error } = await args.db
    .from('notifications')
    .update({ state: 'suppressed', last_error: args.reason })
    .eq('id', args.id)
    .in('state', ['pending', 'failed'])

  return { ok: !error }
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export type DispatchResult = {
  claimed: number
  sent: number
  retrying: number
  dead: number
  failures: Array<{ id: string; message: string }>
}

/** How many to take in one pass, so a backlog does not stall the whole job. */
const BATCH = 50

/**
 * Sends what is due.
 *
 * `db` must be the PRIVILEGED client: the table has RLS forced, no
 * policies, and grants revoked, so nothing else can reach it.
 */
export async function dispatchNotifications(args: {
  db: Db
  now: Date
  limit?: number
}): Promise<DispatchResult> {
  const { db, now } = args
  const result: DispatchResult = { claimed: 0, sent: 0, retrying: 0, dead: 0, failures: [] }

  const { data: due, error } = await db
    .from('notifications')
    .select('id, kind, channel, destination, subject, preview, payload, attempts')
    .in('state', ['pending', 'failed'])
    .lte('next_attempt_at', now.toISOString())
    .order('next_attempt_at', { ascending: true })
    .limit(args.limit ?? BATCH)

  if (error) {
    result.failures.push({ id: '*', message: `query failed: ${error.message}` })
    return result
  }

  const notifier = getNotifier()

  for (const row of due ?? []) {
    // Claim it. A second worker's update matches nothing, so the row is
    // sent once without a lock.
    const { data: claimed } = await db
      .from('notifications')
      .update({ state: 'sending' })
      .eq('id', row.id)
      .in('state', ['pending', 'failed'])
      .select('id')

    if (!claimed || claimed.length === 0) continue
    result.claimed++

    const attempts = row.attempts + 1

    let outcome: SendResult
    try {
      outcome = await notifier.send({
        id: row.id,
        channel: row.channel,
        destination: row.destination,
        subject: row.subject,
        preview: row.preview,
        kind: row.kind,
        payload: (row.payload ?? {}) as Record<string, unknown>,
      })
    } catch (err) {
      outcome = {
        ok: false,
        retryable: true,
        message: err instanceof Error ? err.message : String(err),
      }
    }

    if (outcome.ok) {
      await db
        .from('notifications')
        .update({ state: 'sent', attempts, sent_at: new Date().toISOString(), last_error: null })
        .eq('id', row.id)
      result.sent++
      continue
    }

    // A permanent failure is not retried: a malformed address will still be
    // malformed in six hours, and burning five more attempts on it only
    // delays the ones behind it.
    const giveUp = !outcome.retryable || shouldGiveUp(attempts)

    // The error text may name the destination, which is a contact detail.
    // Stored on the row, which nothing but the service role can read, and
    // never logged.
    await db
      .from('notifications')
      .update({
        state: giveUp ? 'dead' : 'failed',
        attempts,
        last_error: outcome.message.slice(0, 500),
        next_attempt_at: new Date(now.getTime() + backoffSeconds(attempts) * 1000).toISOString(),
      })
      .eq('id', row.id)

    if (giveUp) {
      result.dead++
      result.failures.push({ id: row.id, message: outcome.message })
    } else {
      result.retrying++
    }
  }

  return result
}
