/**
 * Messaging, against the live database.
 *
 * The claim that matters most is that a blocked message is unreadable. Not
 * "hidden in the UI" -- unreadable, refused by the database, to both
 * parties. If somebody sends a fourteen-year-old a threat, the review queue
 * is not the point; the child not reading it is the point.
 *
 * So the reads here go through a client PostgREST sees as a specific
 * signed-in user, and the assertions are about what row level security
 * returns rather than what this code filters.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'
import {
  ensureThread,
  purgeExpiredMessages,
  reportMessage,
  sendMessage,
} from '@/server/messageService'

const url = process.env['NEXT_PUBLIC_SUPABASE_URL']!
const anonKey = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY']!

const admin = createClient<Database>(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

function userScoped(token: string): SupabaseClient<Database> {
  return createClient<Database>(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })
}

const stamp = Date.now()
const PASSWORD = `Test-${stamp}-Aa1!`
const PRICE = 300
const NOW = new Date('2026-09-10T18:00:00Z')

type TestUser = { domainId: string; token: string }

let provider: TestUser
let customer: TestUser
let stranger: TestUser
let subscriptionId = ''
let threadId = ''
const madeUsers: string[] = []

async function makeUser(email: string): Promise<TestUser> {
  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  })
  if (error || !created.user) throw new Error(`createUser failed: ${error?.message}`)
  const { data: du } = await admin
    .from('users')
    .select('id')
    .eq('auth_user_id', created.user.id)
    .single()

  const anon = createClient<Database>(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: session, error: signInErr } = await anon.auth.signInWithPassword({
    email,
    password: PASSWORD,
  })
  if (signInErr || !session.session) throw new Error(`sign in failed: ${signInErr?.message}`)

  madeUsers.push(du!.id)
  return { domainId: du!.id, token: session.session.access_token }
}

async function send(body: string, from: TestUser = customer) {
  return sendMessage({
    db: admin,
    subscriptionId,
    senderUserId: from.domainId,
    body,
    now: NOW,
  })
}

/** What this user can actually read, through their own session. */
async function readable(user: TestUser): Promise<string[]> {
  const { data } = await userScoped(user.token)
    .from('messages')
    .select('body')
    .eq('thread_id', threadId)
  return (data ?? []).map((m) => m.body)
}

beforeAll(async () => {
  provider = await makeUser(`msg-provider-${stamp}@example.com`)
  customer = await makeUser(`msg-customer-${stamp}@example.com`)
  stranger = await makeUser(`msg-stranger-${stamp}@example.com`)

  // A 15-year-old provider, so the minor rules are the ones under test.
  const dob = new Date()
  dob.setUTCFullYear(dob.getUTCFullYear() - 15)
  await admin.from('provider_profiles').insert({
    user_id: provider.domainId,
    date_of_birth: dob.toISOString().slice(0, 10),
    display_first_name: 'Jamie',
    guardian_state: 'verified',
  })

  const { data: biz } = await admin
    .from('businesses')
    .insert({
      provider_user_id: provider.domainId,
      name: `Msg Test ${stamp}`,
      slug: `msg-test-${stamp}`,
      state: 'published',
      published_at: new Date().toISOString(),
      public_area_label: 'Downtown',
    })
    .select('id')
    .single()

  const { data: cat } = await admin
    .from('service_catalog')
    .select('id')
    .eq('code', 'bin_curb_service')
    .single()

  const { data: svc, error: svcErr } = await admin
    .from('provider_services')
    .insert({
      business_id: biz!.id,
      catalog_service_id: cat!.id,
      slug: 'weekly-bins',
      public_name: 'Weekly bins',
      description: 'A description long enough to satisfy the constraint.',
      price_cents: PRICE,
      price_unit: 'week',
      billing_cycle_weeks: 4,
      schedule_rule: { frequency: 'weekly', weekdays: ['tuesday'], timezone: 'UTC' },
      capacity_rule: { maxAddresses: 50 },
      state: 'active',
    })
    .select('id')
    .single()
  if (svcErr) throw new Error(`service insert failed: ${svcErr.message}`)

  const { data: addr } = await admin
    .from('customer_addresses')
    .insert({
      customer_user_id: customer.domainId,
      line1: '9 Message Way',
      city: 'Austin',
      region: 'TX',
      postal_code: '78701',
      country_code: 'US',
    })
    .select('id')
    .single()

  const { data: sub, error: subErr } = await admin
    .from('subscriptions')
    .insert({
      customer_user_id: customer.domainId,
      provider_service_id: svc!.id,
      service_address_id: addr!.id,
      state: 'active',
      provider_price_cents: PRICE,
      price_unit: 'week',
      platform_fee_bps: 1500,
      platform_fee_min_cents: 100,
      billing_cycle_weeks: 4,
      stripe_payment_method_id: `pm_test_${stamp}`,
    })
    .select('id')
    .single()
  if (subErr) throw new Error(`subscription insert failed: ${subErr.message}`)
  subscriptionId = sub!.id

  const thread = await ensureThread({ db: admin, subscriptionId, now: NOW })
  threadId = thread!.id
})

afterAll(async () => {
  if (threadId) {
    await admin.from('messages').delete().eq('thread_id', threadId)
    await admin.from('audit_log').delete().eq('target_id', threadId)
    await admin.from('message_threads').delete().eq('id', threadId)
  }
  if (subscriptionId) {
    await admin.from('service_occurrences').delete().eq('subscription_id', subscriptionId)
    await admin.from('ledger_entries').delete().eq('subscription_id', subscriptionId)
    await admin.from('subscriptions').delete().eq('id', subscriptionId)
  }
  await admin.from('customer_addresses').delete().in('customer_user_id', madeUsers)
  for (const id of madeUsers) {
    const { data: u } = await admin.from('users').select('auth_user_id').eq('id', id).maybeSingle()
    await admin.from('audit_log').delete().eq('actor_user_id', id)
    await admin.from('users').delete().eq('id', id)
    if (u?.auth_user_id) await admin.auth.admin.deleteUser(u.auth_user_id).catch(() => {})
  }
})

describe('the thread is the business relationship', () => {
  it('detects that a minor is party to it', async () => {
    const thread = await ensureThread({ db: admin, subscriptionId, now: NOW })
    expect(thread!.involvesMinor).toBe(true)
  })

  it('is created once, not once per message', async () => {
    const a = await ensureThread({ db: admin, subscriptionId, now: NOW })
    const b = await ensureThread({ db: admin, subscriptionId, now: NOW })
    expect(a!.id).toBe(b!.id)
  })

  it('refuses somebody who is not a party', async () => {
    const r = await send('hello', stranger)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('NOT_A_PARTICIPANT')
  })
})

describe('ordinary messages go through', () => {
  it('delivers one', async () => {
    const r = await send('The side gate was locked so I left them by the porch.', provider)
    expect(r.ok).toBe(true)
  })

  it('is readable by both parties', async () => {
    const forCustomer = await readable(customer)
    const forProvider = await readable(provider)
    expect(forCustomer.some((b) => b.includes('side gate'))).toBe(true)
    expect(forProvider.some((b) => b.includes('side gate'))).toBe(true)
  })

  it('is not readable by a stranger', async () => {
    const forStranger = await readable(stranger)
    expect(forStranger).toHaveLength(0)
  })
})

describe('a blocked message is unreadable, not merely flagged', () => {
  it('refuses to send a phone number', async () => {
    const r = await send('call me on 512-555-0199 instead')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('BLOCKED')
      expect(r.violation).toBe('phone_number')
    }
  })

  it('stores it as evidence', async () => {
    const { data } = await admin
      .from('messages')
      .select('id, state, violation_code')
      .eq('thread_id', threadId)
      .eq('state', 'blocked')
    expect((data ?? []).length).toBeGreaterThan(0)
  })

  it('is invisible to the recipient', async () => {
    const forProvider = await readable(provider)
    expect(forProvider.some((b) => b.includes('555-0199'))).toBe(false)
  })

  it('is invisible to the sender too', async () => {
    // Not "hidden from them in the UI" -- the database refuses it.
    const forCustomer = await readable(customer)
    expect(forCustomer.some((b) => b.includes('555-0199'))).toBe(false)
  })

  it('never reaches a minor when it is a threat', async () => {
    const r = await send('i know where you live')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.violation).toBe('threat')

    const forProvider = await readable(provider)
    expect(forProvider.some((b) => b.includes('where you live'))).toBe(false)
  })

  it('marks a threat urgent so a human looks now', async () => {
    const { data } = await admin
      .from('messages')
      .select('urgent, violation_code')
      .eq('thread_id', threadId)
      .eq('violation_code', 'threat')
    expect(data![0]!.urgent).toBe(true)
  })

  it('escalates prohibited work because a minor is in the thread', async () => {
    await send('could you watch my kids on Thursday')
    const { data } = await admin
      .from('messages')
      .select('urgent')
      .eq('thread_id', threadId)
      .eq('violation_code', 'prohibited_work')
    expect(data![0]!.urgent).toBe(true)
  })

  it('does not tell the sender which pattern matched', async () => {
    const r = await send('just venmo me')
    if (!r.ok) {
      // A hint about how to rephrase it is a hint about how to get through.
      expect(r.message).not.toMatch(/venmo|pattern|regex/i)
    }
  })

  it('audits the attempt without copying the body', async () => {
    const { data } = await admin
      .from('audit_log')
      .select('action, reason_code, after_json')
      .eq('target_id', threadId)
      .eq('action', 'message.blocked')

    expect((data ?? []).length).toBeGreaterThan(0)
    // The body lives on the message row for somebody with a reason to read
    // it; copying it here would put it in a second table.
    expect(JSON.stringify(data)).not.toContain('555-0199')
  })
})

describe('reporting', () => {
  it('lets a party report a delivered message', async () => {
    const sent = await send('Fine I suppose.', provider)
    if (!sent.ok) return

    const r = await reportMessage({
      db: admin,
      messageId: sent.messageId,
      reporterUserId: customer.domainId,
      reason: 'rude',
      now: NOW,
    })
    expect(r.ok).toBe(true)
  })

  it('marks it urgent because a minor is in the thread', async () => {
    const sent = await send('Another one.', provider)
    if (!sent.ok) return

    await reportMessage({
      db: admin,
      messageId: sent.messageId,
      reporterUserId: customer.domainId,
      reason: 'uncomfortable',
      now: NOW,
    })

    const { data } = await admin
      .from('messages')
      .select('urgent, reported_at')
      .eq('id', sent.messageId)
      .single()
    expect(data!.urgent).toBe(true)
    expect(data!.reported_at).toBeTruthy()
  })

  it('extends the retention clock, because it is evidence now', async () => {
    const sent = await send('Third one.', provider)
    if (!sent.ok) return

    const { data: before } = await admin
      .from('messages')
      .select('purge_after')
      .eq('id', sent.messageId)
      .single()

    await reportMessage({
      db: admin,
      messageId: sent.messageId,
      reporterUserId: customer.domainId,
      reason: 'keeping this',
      now: NOW,
    })

    const { data: after } = await admin
      .from('messages')
      .select('purge_after')
      .eq('id', sent.messageId)
      .single()

    expect(new Date(after!.purge_after).getTime()).toBeGreaterThan(
      new Date(before!.purge_after).getTime(),
    )
  })

  it('refuses a stranger', async () => {
    const sent = await send('Not yours.', provider)
    if (!sent.ok) return

    const r = await reportMessage({
      db: admin,
      messageId: sent.messageId,
      reporterUserId: stranger.domainId,
      reason: 'nosy',
      now: NOW,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('NOT_A_PARTICIPANT')
  })
})

describe('retention is implemented, not just documented', () => {
  it('redacts a body past its purge date without deleting the row', async () => {
    const sent = await send('This one is old.', provider)
    if (!sent.ok) return

    await admin
      .from('messages')
      .update({ purge_after: '2020-01-01T00:00:00Z' })
      .eq('id', sent.messageId)

    const result = await purgeExpiredMessages({ db: admin, now: NOW })
    expect(result.purged).toBeGreaterThan(0)

    const { data } = await admin
      .from('messages')
      .select('body, state')
      .eq('id', sent.messageId)
      .single()

    // The fact a conversation happened stays; the words do not.
    expect(data!.state).toBe('redacted')
    expect(data!.body).not.toContain('This one is old')
  })

  it('leaves messages inside their window alone', async () => {
    const sent = await send('Still current.', provider)
    if (!sent.ok) return

    await purgeExpiredMessages({ db: admin, now: NOW })

    const { data } = await admin
      .from('messages')
      .select('body, state')
      .eq('id', sent.messageId)
      .single()
    expect(data!.state).toBe('delivered')
    expect(data!.body).toBe('Still current.')
  })
})
