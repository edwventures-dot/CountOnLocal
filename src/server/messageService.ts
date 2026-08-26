/**
 * Sending, reading and reporting messages.
 *
 * The content rules are in domain/messaging.ts. This resolves who is
 * allowed to talk to whom, stores what was said, and keeps what was refused.
 *
 * ## A refused message is still written down
 *
 * Blocked messages are stored with state 'blocked' and are unreadable by
 * either participant -- 0023's policy only returns delivered ones. They are
 * kept because they are evidence about a minor's safety, and because
 * somebody who tries three times to get a phone number through is a
 * different problem from somebody who tried once by accident. Discarding
 * the attempt would erase the pattern.
 *
 * The sender is told the message could not be sent. They are not told which
 * pattern matched, because that is a hint about how to rephrase it.
 */

import {
  checkLength,
  checkMessage,
  retentionDaysFor,
  type ViolationCode,
} from '@/domain/messaging'
import { classifyAge, parsePlainDate } from '@/domain/age'
import { writeAudit } from '@/server/audit'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'

type Db = SupabaseClient<Database>

export type MessageFailure =
  | 'NOT_FOUND'
  | 'NOT_A_PARTICIPANT'
  | 'BLOCKED'
  | 'INVALID'
  | 'WRITE_FAILED'

export type SendResult =
  | { ok: true; messageId: string }
  | {
      ok: false
      code: MessageFailure
      message: string
      /** Present when the content rules refused it. */
      violation?: ViolationCode | undefined
    }

type Thread = {
  id: string
  subscriptionId: string
  customerUserId: string
  providerUserId: string
  involvesMinor: boolean
}

/**
 * The thread for a subscription, created on first use.
 *
 * `involves_minor` is computed here from the provider's date of birth
 * rather than from a cached band, because a birthday between two messages
 * would otherwise leave the flag wrong in the direction that matters least
 * safely.
 */
export async function ensureThread(args: {
  db: Db
  subscriptionId: string
  now: Date
}): Promise<Thread | null> {
  const { db, subscriptionId } = args

  const { data: existing } = await db
    .from('message_threads')
    .select('id, subscription_id, customer_user_id, provider_user_id, involves_minor')
    .eq('subscription_id', subscriptionId)
    .maybeSingle()

  const { data: sub } = await db
    .from('subscriptions')
    .select(
      `id, customer_user_id,
       provider_services!inner (
         businesses!inner ( provider_user_id )
       )`,
    )
    .eq('id', subscriptionId)
    .maybeSingle()

  if (!sub) return null

  const one = <T,>(v: unknown): T | undefined => (Array.isArray(v) ? v[0] : v) as T | undefined
  const svc = one<{ businesses: unknown }>(sub.provider_services)
  const biz = one<{ provider_user_id: string }>(svc?.businesses)
  if (!biz) return null

  const { data: profile } = await db
    .from('provider_profiles')
    .select('date_of_birth')
    .eq('user_id', biz.provider_user_id)
    .maybeSingle()

  const involvesMinor = profile
    ? classifyAge(parsePlainDate(profile.date_of_birth), {
        year: args.now.getUTCFullYear(),
        month: args.now.getUTCMonth() + 1,
        day: args.now.getUTCDate(),
      }) === 'minor'
    : false

  if (existing) {
    // Keep the flag current -- a provider turning 18 between messages
    // should stop being treated as a minor, and a stale flag in the other
    // direction would quietly relax a safety rule.
    if (existing.involves_minor !== involvesMinor) {
      await db
        .from('message_threads')
        .update({ involves_minor: involvesMinor })
        .eq('id', existing.id)
    }
    return {
      id: existing.id,
      subscriptionId: existing.subscription_id,
      customerUserId: existing.customer_user_id,
      providerUserId: existing.provider_user_id,
      involvesMinor,
    }
  }

  const { data: created, error } = await db
    .from('message_threads')
    .insert({
      subscription_id: subscriptionId,
      customer_user_id: sub.customer_user_id,
      provider_user_id: biz.provider_user_id,
      involves_minor: involvesMinor,
    })
    .select('id')
    .single()

  if (error || !created) {
    // A parallel first message. Read it back rather than failing.
    const { data: raced } = await db
      .from('message_threads')
      .select('id, subscription_id, customer_user_id, provider_user_id, involves_minor')
      .eq('subscription_id', subscriptionId)
      .maybeSingle()
    if (!raced) return null
    return {
      id: raced.id,
      subscriptionId: raced.subscription_id,
      customerUserId: raced.customer_user_id,
      providerUserId: raced.provider_user_id,
      involvesMinor: raced.involves_minor,
    }
  }

  return {
    id: created.id,
    subscriptionId,
    customerUserId: sub.customer_user_id,
    providerUserId: biz.provider_user_id,
    involvesMinor,
  }
}

function daysFromNow(now: Date, days: number): string {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString()
}

/**
 * Sends a message, or records the attempt and refuses.
 *
 * `db` must be the PRIVILEGED client: 0023 allows no client writes.
 */
export async function sendMessage(args: {
  db: Db
  subscriptionId: string
  senderUserId: string
  body: string
  now: Date
  ip?: string | null
}): Promise<SendResult> {
  const { db, senderUserId, now } = args

  const length = checkLength(args.body)
  if (!length.ok) return { ok: false, code: 'INVALID', message: length.message }

  const thread = await ensureThread({ db, subscriptionId: args.subscriptionId, now })
  if (!thread) return { ok: false, code: 'NOT_FOUND', message: 'No such conversation.' }

  if (senderUserId !== thread.customerUserId && senderUserId !== thread.providerUserId) {
    return {
      ok: false,
      code: 'NOT_A_PARTICIPANT',
      message: 'Only the customer and the provider on this service can message here.',
    }
  }

  const verdict = checkMessage(length.body, { involvesMinor: thread.involvesMinor })

  if (verdict.verdict === 'block') {
    // Stored, unreadable, and kept longer because it is evidence.
    const { error } = await db.from('messages').insert({
      thread_id: thread.id,
      sender_user_id: senderUserId,
      body: length.body,
      state: 'blocked',
      violation_code: verdict.code,
      urgent: verdict.urgent,
      purge_after: daysFromNow(now, retentionDaysFor({ flagged: true })),
    })

    if (error) console.error('[messages] blocked-message write failed', error.message)

    await writeAudit({
      actorUserId: senderUserId,
      actorRole: senderUserId === thread.providerUserId ? 'provider' : 'customer',
      action: 'message.blocked',
      targetType: 'message_thread',
      targetId: thread.id,
      // The body is deliberately absent. It is on the message row for a
      // human with a reason to read it; copying it here would put it in a
      // second table with different access rules.
      after: { violation: verdict.code, urgent: verdict.urgent },
      reasonCode: verdict.code,
      ip: args.ip ?? null,
    })

    return {
      ok: false,
      code: 'BLOCKED',
      message: verdict.message,
      violation: verdict.code,
    }
  }

  const { data, error } = await db
    .from('messages')
    .insert({
      thread_id: thread.id,
      sender_user_id: senderUserId,
      body: length.body,
      state: 'delivered',
      purge_after: daysFromNow(now, retentionDaysFor({ flagged: false })),
    })
    .select('id')
    .single()

  if (error) {
    console.error('[messages] send failed', error.message)
    return { ok: false, code: 'WRITE_FAILED', message: 'Could not send that. Try again.' }
  }

  await db
    .from('message_threads')
    .update({ last_message_at: now.toISOString() })
    .eq('id', thread.id)

  return { ok: true, messageId: data!.id }
}

export type ReportResult =
  | { ok: true }
  | { ok: false; code: MessageFailure; message: string }

/**
 * Reports a delivered message.
 *
 * Separate from an automatic block: this is a human saying something is
 * wrong that the patterns did not catch, which is the case the patterns
 * cannot cover and the reason the button has to be there.
 *
 * Reporting extends the retention clock, because a reported message is
 * evidence whatever a reviewer eventually decides.
 */
export async function reportMessage(args: {
  db: Db
  messageId: string
  reporterUserId: string
  reason: string
  now: Date
  ip?: string | null
}): Promise<ReportResult> {
  const { db, messageId, reporterUserId, now } = args

  const reason = args.reason.trim().slice(0, 200)
  if (!reason) return { ok: false, code: 'INVALID', message: 'Say what is wrong with it.' }

  const { data: message } = await db
    .from('messages')
    .select('id, thread_id, state')
    .eq('id', messageId)
    .maybeSingle()

  if (!message) return { ok: false, code: 'NOT_FOUND', message: 'No such message.' }

  const { data: thread } = await db
    .from('message_threads')
    .select('id, customer_user_id, provider_user_id, involves_minor')
    .eq('id', message.thread_id)
    .maybeSingle()

  if (
    !thread ||
    (reporterUserId !== thread.customer_user_id && reporterUserId !== thread.provider_user_id)
  ) {
    return {
      ok: false,
      code: 'NOT_A_PARTICIPANT',
      message: 'Only somebody in this conversation can report it.',
    }
  }

  const { error } = await db
    .from('messages')
    .update({
      reported_at: now.toISOString(),
      reported_by_user_id: reporterUserId,
      report_reason: reason,
      // A thread with a minor in it goes to the front of the queue.
      // SAFETY_TRUST_POLICY section 9: safety reports outrank support.
      urgent: thread.involves_minor,
      purge_after: daysFromNow(now, retentionDaysFor({ flagged: true })),
    })
    .eq('id', messageId)
    .is('reported_at', null)

  if (error) {
    console.error('[messages] report failed', error.message)
    return { ok: false, code: 'WRITE_FAILED', message: 'Could not save that. Try again.' }
  }

  await writeAudit({
    actorUserId: reporterUserId,
    actorRole: null,
    action: 'message.reported',
    targetType: 'message',
    targetId: messageId,
    after: { urgent: thread.involves_minor },
    reasonCode: 'user_report',
    ip: args.ip ?? null,
  })

  return { ok: true }
}

/**
 * Purges message bodies past their retention date.
 *
 * PRD section 17 requires a retention policy be implemented, not merely
 * documented, and TECHNICAL_SPEC section 23 warns against inventing
 * indefinite retention. Rows are redacted rather than deleted: the fact
 * that a conversation happened stays, the words do not.
 */
export async function purgeExpiredMessages(args: {
  db: Db
  now: Date
  limit?: number
}): Promise<{ purged: number }> {
  const { data, error } = await args.db
    .from('messages')
    .update({ body: '[removed on retention schedule]', state: 'redacted' })
    .lt('purge_after', args.now.toISOString())
    .neq('state', 'redacted')
    .select('id')
    .limit(args.limit ?? 500)

  if (error) {
    console.error('[messages] purge failed', error.message)
    return { purged: 0 }
  }
  return { purged: (data ?? []).length }
}
