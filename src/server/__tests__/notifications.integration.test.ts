/**
 * The outbox, against the live database.
 *
 * What matters here is the behaviour under failure, because the whole point
 * of an outbox is that a send can fail without the message being lost:
 *
 *   - a queued notification survives a failed send and is retried;
 *   - a permanent failure is not retried forever;
 *   - two workers cannot send the same row twice;
 *   - a repeated event does not queue a second copy;
 *   - a draft carrying an address or a gate code never reaches the table.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'
import {
  dispatchNotifications,
  enqueueNotification,
  setNotifier,
  StubNotifier,
  suppressNotification,
  UnconfiguredNotifier,
} from '@/server/notifications'
import { MAX_ATTEMPTS } from '@/domain/notification'

const url = process.env['NEXT_PUBLIC_SUPABASE_URL']!
const anonKey = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY']!

const admin = createClient<Database>(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})
const anon = createClient<Database>(url, anonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const stamp = Date.now()
const NOW = new Date('2026-09-10T18:00:00Z')

let notifier: StubNotifier
const madeIds: string[] = []

async function enqueue(overrides: Record<string, unknown> = {}) {
  const r = await enqueueNotification({
    db: admin,
    draft: {
      kind: 'subscription.new_subscriber',
      channel: 'email',
      destination: `outbox-${stamp}-${madeIds.length}@example.com`,
      subject: 'You have a new customer',
      preview: 'Someone in Oak Ridge subscribed to your Tuesday route.',
      ...overrides,
    } as never,
  })
  if (r.ok && r.id) madeIds.push(r.id)
  return r
}

async function rowFor(id: string) {
  const { data } = await admin
    .from('notifications')
    .select('state, attempts, last_error, sent_at, next_attempt_at, subject')
    .eq('id', id)
    .single()
  return data!
}

beforeEach(() => {
  notifier = new StubNotifier()
  setNotifier(notifier)
})

afterAll(async () => {
  if (madeIds.length) await admin.from('notifications').delete().in('id', madeIds)
  await admin.from('notifications').delete().like('destination', `outbox-${stamp}-%`)
  setNotifier(new UnconfiguredNotifier())
})

describe('nothing sensitive reaches the table', () => {
  it('refuses a subject containing an address', async () => {
    const r = await enqueue({ subject: 'Your visit at 100 Oak St' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('INVALID')
  })

  it('refuses a preview containing a gate code', async () => {
    const r = await enqueue({ preview: 'Gate code 4417, see you Tuesday' })
    expect(r.ok).toBe(false)
  })

  it('refuses a payload carrying an address line', async () => {
    const r = await enqueue({ payload: { line1: '742 Evergreen Terrace' } })
    expect(r.ok).toBe(false)
  })

  it('refuses an invented kind', async () => {
    const r = await enqueue({ kind: 'marketing.blast' })
    expect(r.ok).toBe(false)
  })

  it('writes nothing when it refuses', async () => {
    const before = await admin
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .like('destination', `outbox-${stamp}-%`)

    await enqueue({ subject: 'Visit at 25 Elm Rd' })

    const after = await admin
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .like('destination', `outbox-${stamp}-%`)

    expect(after.count).toBe(before.count)
  })
})

describe('a queued notification is sent once', () => {
  it('goes out and is marked sent', async () => {
    const r = await enqueue()
    expect(r.ok).toBe(true)
    if (!r.ok) return

    const dispatched = await dispatchNotifications({ db: admin, now: NOW })
    expect(dispatched.sent).toBeGreaterThanOrEqual(1)

    const row = await rowFor(r.id)
    expect(row.state).toBe('sent')
    expect(row.sent_at).toBeTruthy()
    expect(row.attempts).toBe(1)
  })

  it('is not sent again on the next run', async () => {
    const r = await enqueue()
    if (!r.ok) return

    await dispatchNotifications({ db: admin, now: NOW })
    const countAfterFirst = notifier.sent.length

    await dispatchNotifications({ db: admin, now: NOW })
    expect(notifier.sent.length).toBe(countAfterFirst)
  })

  it('carries the subject and preview through to the sender', async () => {
    const r = await enqueue({ subject: 'A new customer', preview: 'Tuesday route' })
    if (!r.ok) return

    await dispatchNotifications({ db: admin, now: NOW })
    const sent = notifier.sent.find((s) => s.subject === 'A new customer')
    expect(sent).toBeTruthy()
    expect(sent!.preview).toBe('Tuesday route')
  })
})

describe('a message queued and dispatched in the same run leaves in that run', () => {
  it('does not wait for the next run because two clocks disagree', async () => {
    // The daily job takes one `now` at the top and hands it to every job,
    // settling and then notifying, so that receipts leave immediately
    // rather than a schedule later. Every other test in this file pins both
    // sides to a fixed NOW far in the future, which is why this never
    // showed up: with the column default the row was stamped by the
    // DATABASE clock, which here runs about a second ahead of the app's, so
    // a row enqueued at T had next_attempt_at of T+1s and a dispatch at T
    // could not see it. On a once-a-day cron that is a day's delay.
    //
    // Uses the real clock deliberately. A synthetic one would hide it again.
    const now = new Date()

    const r = await enqueueNotification({
      db: admin,
      draft: {
        kind: 'subscription.new_subscriber',
        channel: 'email',
        destination: `samerun-${stamp}@example.com`,
        subject: 'You have a new customer',
        preview: 'Someone nearby subscribed.',
      },
      now,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    madeIds.push(r.id)

    const dispatched = await dispatchNotifications({ db: admin, now })
    expect(dispatched.claimed).toBeGreaterThanOrEqual(1)
    expect((await rowFor(r.id)).state).toBe('sent')
  })

  it('stamps the row from the clock it was given, not the database', async () => {
    const now = new Date('2026-09-01T12:00:00Z')
    const r = await enqueueNotification({
      db: admin,
      draft: {
        kind: 'subscription.new_subscriber',
        channel: 'email',
        destination: `stamped-${stamp}@example.com`,
        subject: 'You have a new customer',
        preview: 'Someone nearby subscribed.',
      },
      now,
    })
    if (!r.ok) return
    madeIds.push(r.id)

    expect(new Date((await rowFor(r.id)).next_attempt_at).toISOString()).toBe(now.toISOString())
  })
})

describe('a failed send is not a lost message', () => {
  it('stays in the outbox and is retried', async () => {
    notifier.setOutcome({ ok: false, retryable: true, message: 'provider timeout' })

    const r = await enqueue()
    if (!r.ok) return

    await dispatchNotifications({ db: admin, now: NOW })

    const row = await rowFor(r.id)
    expect(row.state).toBe('failed')
    expect(row.attempts).toBe(1)
    expect(row.last_error).toContain('timeout')
  })

  it('waits before trying again', async () => {
    notifier.setOutcome({ ok: false, retryable: true, message: 'busy' })
    const r = await enqueue()
    if (!r.ok) return

    await dispatchNotifications({ db: admin, now: NOW })
    const row = await rowFor(r.id)
    expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(NOW.getTime())

    // A run at the same instant does not pick it up again.
    const second = await dispatchNotifications({ db: admin, now: NOW })
    expect(second.claimed).toBe(0)
  })

  it('succeeds on a later attempt', async () => {
    notifier.setOutcome({ ok: false, retryable: true, message: 'busy' })
    const r = await enqueue()
    if (!r.ok) return
    await dispatchNotifications({ db: admin, now: NOW })

    notifier.setOutcome({ ok: true })
    const later = new Date(NOW.getTime() + 60_000)
    await dispatchNotifications({ db: admin, now: later })

    const row = await rowFor(r.id)
    expect(row.state).toBe('sent')
    expect(row.attempts).toBe(2)
  })

  it('gives up on a permanent failure without burning retries', async () => {
    notifier.setOutcome({ ok: false, retryable: false, message: 'invalid address' })
    const r = await enqueue()
    if (!r.ok) return

    await dispatchNotifications({ db: admin, now: NOW })

    const row = await rowFor(r.id)
    // Dead on the first attempt: a malformed address will still be
    // malformed in six hours.
    expect(row.state).toBe('dead')
    expect(row.attempts).toBe(1)
  })

  it('gives up after MAX_ATTEMPTS of retryable failures', async () => {
    notifier.setOutcome({ ok: false, retryable: true, message: 'still down' })
    const r = await enqueue()
    if (!r.ok) return

    let clock = NOW
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await dispatchNotifications({ db: admin, now: clock })
      clock = new Date(clock.getTime() + 12 * 60 * 60 * 1000)
    }

    const row = await rowFor(r.id)
    expect(row.state).toBe('dead')
    expect(row.attempts).toBe(MAX_ATTEMPTS)
  })

  it('survives a sender that throws rather than returning', async () => {
    notifier.setOutcome(() => {
      throw new Error('socket hang up')
    })
    const r = await enqueue()
    if (!r.ok) return

    const dispatched = await dispatchNotifications({ db: admin, now: NOW })
    expect(dispatched.retrying).toBeGreaterThanOrEqual(1)

    const row = await rowFor(r.id)
    expect(row.state).toBe('failed')
  })
})

describe('a repeated event does not queue twice', () => {
  it('returns the existing row', async () => {
    const key = `cycle:${stamp}`
    const first = await enqueueNotification({
      db: admin,
      draft: {
        kind: 'cycle.settled',
        channel: 'email',
        destination: `outbox-${stamp}-dupe@example.com`,
        subject: 'Your receipt',
      },
      idempotencyKey: key,
    })
    expect(first.ok).toBe(true)
    if (first.ok) madeIds.push(first.id)

    const second = await enqueueNotification({
      db: admin,
      draft: {
        kind: 'cycle.settled',
        channel: 'email',
        destination: `outbox-${stamp}-dupe@example.com`,
        subject: 'Your receipt',
      },
      idempotencyKey: key,
    })

    expect(second.ok).toBe(true)
    if (second.ok && first.ok) {
      expect(second.duplicate).toBe(true)
      expect(second.id).toBe(first.id)
    }
  })
})

describe('suppression', () => {
  it('can silence an ordinary update', async () => {
    const r = await enqueue({ kind: 'occurrence.completed' })
    if (!r.ok) return

    const s = await suppressNotification({
      db: admin,
      id: r.id,
      kind: 'occurrence.completed',
      reason: 'no sms consent',
    })
    expect(s.ok).toBe(true)

    expect((await rowFor(r.id)).state).toBe('suppressed')
    const dispatched = await dispatchNotifications({ db: admin, now: NOW })
    expect(dispatched.failures).toEqual([])
  })

  it('refuses to silence a payment failure', async () => {
    const r = await enqueue({ kind: 'subscription.payment_failed', subject: 'Payment problem' })
    if (!r.ok) return

    const s = await suppressNotification({
      db: admin,
      id: r.id,
      kind: 'subscription.payment_failed',
      reason: 'user opted out',
    })

    expect(s.ok).toBe(false)
    expect(s.refused).toBe(true)
    expect((await rowFor(r.id)).state).toBe('pending')
  })

  it('refuses to silence a safety alert', async () => {
    const r = await enqueue({ kind: 'safety.alert', subject: 'Please read this' })
    if (!r.ok) return

    const s = await suppressNotification({
      db: admin,
      id: r.id,
      kind: 'safety.alert',
      reason: 'too many emails',
    })
    expect(s.refused).toBe(true)
  })
})

describe('the table is not reachable through the API', () => {
  it('refuses an anonymous read', async () => {
    const { error } = await anon.from('notifications').select('destination').limit(1)
    // Grants revoked, so this is a 401 rather than an empty list.
    expect(error).not.toBeNull()
  })
})

describe('with no provider configured', () => {
  it('fails permanently and says so, rather than pretending', async () => {
    setNotifier(new UnconfiguredNotifier())

    const r = await enqueue()
    if (!r.ok) return

    await dispatchNotifications({ db: admin, now: NOW })

    const row = await rowFor(r.id)
    expect(row.state).toBe('dead')
    expect(row.last_error).toContain('No notification provider is configured')
  })
})
