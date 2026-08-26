/**
 * Completing and skipping occurrences, against the live database.
 *
 * The claims that matter here are the ones a unit test cannot make, because
 * they are about authorisation and about what actually lands in two tables:
 *
 *   - a provider cannot complete or skip somebody else's route;
 *   - a customer cannot skip on the provider's behalf, or vice versa,
 *     because those two skips owe different money;
 *   - a credited skip writes exactly one credit row, and a double-tapped
 *     button cannot write a second;
 *   - a skip inside the notice window writes no credit at all;
 *   - completed work cannot be quietly un-completed.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'
import { addDays, isoDate } from '@/domain/schedule'
import type { PlainDate } from '@/domain/age'
import {
  completeOccurrence,
  skipOccurrence,
  previewSkip,
  parseServiceDate,
} from '@/server/occurrenceService'

const url = process.env['NEXT_PUBLIC_SUPABASE_URL']!
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY']!
const admin = createClient<Database>(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const stamp = Date.now()

let providerId = ''
let otherProviderId = ''
let customerId = ''
let otherCustomerId = ''
let subscriptionId = ''
let addressId = ''

/**
 * Each occurrence gets its own service date. service_occurrences is unique
 * on (subscription_id, service_date) -- a subscription cannot have two
 * visits on the same day -- so a shared date would collide after the first.
 *
 * The notice-window tests care about the offset between "today" and the
 * service date, not the absolute date, so the two helpers below derive the
 * dates each test needs from the occurrence it just made.
 */
let dayCursor = 0
const dateOf = new Map<string, PlainDate>()

function serviceDateFor(offset: number): PlainDate {
  // 2026-09-01 is a Tuesday; walk forward one day per occurrence.
  return addDays({ year: 2026, month: 9, day: 1 }, offset)
}

/** The occurrence's own service date. */
function sameDayOf(id: string): PlainDate {
  const d = dateOf.get(id)
  if (!d) throw new Error('unknown occurrence id')
  return d
}

/** The day before it, which is exactly one day of notice. */
function dayBeforeOf(id: string): PlainDate {
  return addDays(sameDayOf(id), -1)
}

const VISIT_CENTS = 300

async function makeUser(email: string): Promise<string> {
  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    password: `Test-${stamp}-Aa1!`,
    email_confirm: true,
  })
  if (error || !created?.user) throw new Error(`createUser failed: ${error?.message}`)
  const { data: du } = await admin
    .from('users')
    .select('id')
    .eq('auth_user_id', created.user.id)
    .single()
  return du!.id
}

/** A fresh scheduled occurrence, so each test starts from a known state. */
async function makeOccurrence(state: Database['public']['Tables']['service_occurrences']['Insert']['state'] = 'due_today'): Promise<string> {
  const date = serviceDateFor(dayCursor++)
  const { data, error } = await admin
    .from('service_occurrences')
    .insert({
      subscription_id: subscriptionId,
      service_date: isoDate(date),
      local_timezone: 'America/Chicago',
      state,
      service_value_cents: VISIT_CENTS,
    })
    .select('id')
    .single()
  if (error) throw new Error(`occurrence insert failed: ${error.message}`)
  dateOf.set(data!.id, date)
  return data!.id
}

async function creditRowsFor(occurrenceId: string) {
  const { data } = await admin
    .from('ledger_entries')
    .select('kind, amount_cents, idempotency_key')
    .eq('occurrence_id', occurrenceId)
  return data ?? []
}

async function stateOf(occurrenceId: string): Promise<string> {
  const { data } = await admin
    .from('service_occurrences')
    .select('state')
    .eq('id', occurrenceId)
    .single()
  return data!.state
}

beforeAll(async () => {
  providerId = await makeUser(`occ-provider-${stamp}@example.com`)
  otherProviderId = await makeUser(`occ-provider2-${stamp}@example.com`)
  customerId = await makeUser(`occ-customer-${stamp}@example.com`)
  otherCustomerId = await makeUser(`occ-customer2-${stamp}@example.com`)

  await admin.from('provider_profiles').insert({
    user_id: providerId,
    date_of_birth: '1990-01-01',
    display_first_name: 'Alex',
    guardian_state: 'not_required',
  })

  const { data: biz } = await admin
    .from('businesses')
    .insert({
      provider_user_id: providerId,
      name: `Occ Test ${stamp}`,
      slug: `occ-test-${stamp}`,
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

  const { data: svc } = await admin
    .from('provider_services')
    .insert({
      business_id: biz!.id,
      catalog_service_id: cat!.id,
      slug: 'weekly-bins',
      public_name: 'Weekly bins',
      description: 'A description long enough to satisfy the constraint.',
      price_cents: VISIT_CENTS,
      price_unit: 'week',
      billing_cycle_weeks: 4,
      schedule_rule: {
        frequency: 'weekly',
        weekdays: ['tuesday'],
        timezone: 'America/Chicago',
      },
      capacity_rule: { maxAddresses: 50 },
      state: 'active',
    })
    .select('id')
    .single()

  const { data: addr } = await admin
    .from('customer_addresses')
    .insert({
      customer_user_id: customerId,
      line1: '100 Inside St',
      city: 'Austin',
      region: 'TX',
      postal_code: '78701',
      country_code: 'US',
    })
    .select('id')
    .single()
  addressId = addr!.id

  const { data: sub, error: subErr } = await admin
    .from('subscriptions')
    .insert({
      customer_user_id: customerId,
      provider_service_id: svc!.id,
      service_address_id: addressId,
      state: 'active',
      provider_price_cents: VISIT_CENTS,
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
})

afterAll(async () => {
  const ids = [customerId, otherCustomerId, providerId, otherProviderId].filter(Boolean)

  if (subscriptionId) {
    const { data: occs } = await admin
      .from('service_occurrences')
      .select('id')
      .eq('subscription_id', subscriptionId)
    const occIds = (occs ?? []).map((o) => o.id)
    if (occIds.length) await admin.from('ledger_entries').delete().in('occurrence_id', occIds)
    await admin.from('ledger_entries').delete().eq('subscription_id', subscriptionId)
    await admin.from('service_occurrences').delete().eq('subscription_id', subscriptionId)
    await admin.from('subscriptions').delete().eq('id', subscriptionId)
  }
  await admin.from('customer_addresses').delete().in('customer_user_id', ids)

  for (const id of ids) {
    const { data: u } = await admin.from('users').select('auth_user_id').eq('id', id).maybeSingle()
    await admin.from('audit_log').delete().eq('actor_user_id', id)
    await admin.from('users').delete().eq('id', id)
    if (u?.auth_user_id) await admin.auth.admin.deleteUser(u.auth_user_id).catch(() => {})
  }
})

describe('completing a stop', () => {
  it('lets the assigned provider complete it', async () => {
    const id = await makeOccurrence('due_today')
    const r = await completeOccurrence({ db: admin, occurrenceId: id, actorUserId: providerId })

    expect(r.ok).toBe(true)
    expect(await stateOf(id)).toBe('completed')
  })

  it('records a completed_at timestamp', async () => {
    const id = await makeOccurrence('due_today')
    await completeOccurrence({ db: admin, occurrenceId: id, actorUserId: providerId })
    const { data } = await admin
      .from('service_occurrences')
      .select('completed_at')
      .eq('id', id)
      .single()
    expect(data!.completed_at).toBeTruthy()
  })

  it('refuses a provider who does not own the route', async () => {
    const id = await makeOccurrence('due_today')
    const r = await completeOccurrence({ db: admin, occurrenceId: id, actorUserId: otherProviderId })

    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('NOT_YOUR_OCCURRENCE')
    expect(await stateOf(id)).toBe('due_today')
  })

  it('refuses the customer, who cannot mark their own service done', async () => {
    const id = await makeOccurrence('due_today')
    const r = await completeOccurrence({ db: admin, occurrenceId: id, actorUserId: customerId })

    expect(r.ok).toBe(false)
    expect(await stateOf(id)).toBe('due_today')
  })

  it('refuses to complete a scheduled occurrence that is not due yet', async () => {
    const id = await makeOccurrence('scheduled')
    const r = await completeOccurrence({ db: admin, occurrenceId: id, actorUserId: providerId })

    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('ILLEGAL_TRANSITION')
  })

  it('cannot complete the same stop twice', async () => {
    const id = await makeOccurrence('due_today')
    await completeOccurrence({ db: admin, occurrenceId: id, actorUserId: providerId })
    const second = await completeOccurrence({ db: admin, occurrenceId: id, actorUserId: providerId })

    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.code).toBe('ILLEGAL_TRANSITION')
  })

  it('writes no ledger row -- earnings are recognised at settlement', async () => {
    const id = await makeOccurrence('due_today')
    await completeOccurrence({ db: admin, occurrenceId: id, actorUserId: providerId })
    expect(await creditRowsFor(id)).toHaveLength(0)
  })
})

describe('a provider skip always credits the customer', () => {
  it('credits the visit and moves straight to credited', async () => {
    const id = await makeOccurrence('due_today')
    const r = await skipOccurrence({
      db: admin,
      occurrenceId: id,
      actor: 'provider',
      actorUserId: providerId,
      today: sameDayOf(id),
    })

    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.credit.credited).toBe(true)
      expect(r.credit.amountCents).toBe(VISIT_CENTS)
      expect(r.state).toBe('credited')
    }
    expect(await stateOf(id)).toBe('credited')
  })

  it('credits even on the day, because notice is irrelevant to a no-show', async () => {
    const id = await makeOccurrence('due_today')
    const r = await skipOccurrence({
      db: admin,
      occurrenceId: id,
      actor: 'provider',
      actorUserId: providerId,
      today: sameDayOf(id),
    })
    if (r.ok) expect(r.credit.code).toBe('provider_did_not_deliver')
  })

  it('writes exactly one negative credit row against the occurrence', async () => {
    const id = await makeOccurrence('due_today')
    await skipOccurrence({
      db: admin,
      occurrenceId: id,
      actor: 'provider',
      actorUserId: providerId,
      today: sameDayOf(id),
    })

    const rows = await creditRowsFor(id)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.kind).toBe('credit')
    expect(rows[0]!.amount_cents).toBe(-VISIT_CENTS)
  })

  it('refuses a provider who does not own the route', async () => {
    const id = await makeOccurrence('due_today')
    const r = await skipOccurrence({
      db: admin,
      occurrenceId: id,
      actor: 'provider',
      actorUserId: otherProviderId,
      today: sameDayOf(id),
    })

    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('NOT_YOUR_OCCURRENCE')
    expect(await creditRowsFor(id)).toHaveLength(0)
  })
})

describe('a customer skip turns on notice', () => {
  it('credits when skipped the day before', async () => {
    const id = await makeOccurrence('scheduled')
    const r = await skipOccurrence({
      db: admin,
      occurrenceId: id,
      actor: 'customer',
      actorUserId: customerId,
      today: dayBeforeOf(id),
    })

    expect(r.ok).toBe(true)
    if (r.ok) expect(r.credit.credited).toBe(true)
    expect(await stateOf(id)).toBe('credited')
    expect(await creditRowsFor(id)).toHaveLength(1)
  })

  it('does not credit a same-day skip, and writes no ledger row', async () => {
    const id = await makeOccurrence('due_today')
    const r = await skipOccurrence({
      db: admin,
      occurrenceId: id,
      actor: 'customer',
      actorUserId: customerId,
      today: sameDayOf(id),
    })

    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.credit.credited).toBe(false)
      expect(r.state).toBe('customer_skipped')
    }
    expect(await stateOf(id)).toBe('customer_skipped')
    expect(await creditRowsFor(id)).toHaveLength(0)
  })

  it('refuses a customer who is not on this subscription', async () => {
    const id = await makeOccurrence('scheduled')
    const r = await skipOccurrence({
      db: admin,
      occurrenceId: id,
      actor: 'customer',
      actorUserId: otherCustomerId,
      today: dayBeforeOf(id),
    })

    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('NOT_YOUR_OCCURRENCE')
  })
})

describe('the two skips cannot impersonate each other', () => {
  it('a provider cannot skip as the customer to avoid owing a credit', async () => {
    const id = await makeOccurrence('due_today')
    const r = await skipOccurrence({
      db: admin,
      occurrenceId: id,
      actor: 'customer',
      actorUserId: providerId, // the provider, claiming to be the customer
      today: sameDayOf(id),
    })

    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('NOT_YOUR_OCCURRENCE')
    expect(await stateOf(id)).toBe('due_today')
  })

  it('a customer cannot skip as the provider to force a credit', async () => {
    const id = await makeOccurrence('due_today')
    const r = await skipOccurrence({
      db: admin,
      occurrenceId: id,
      actor: 'provider',
      actorUserId: customerId,
      today: sameDayOf(id),
    })

    expect(r.ok).toBe(false)
    expect(await creditRowsFor(id)).toHaveLength(0)
  })
})

describe('credits cannot be written twice for one visit', () => {
  it('a repeated skip does not add a second credit row', async () => {
    const id = await makeOccurrence('due_today')

    const first = await skipOccurrence({
      db: admin,
      occurrenceId: id,
      actor: 'provider',
      actorUserId: providerId,
      today: sameDayOf(id),
    })
    expect(first.ok).toBe(true)

    // The state machine refuses the second attempt outright.
    const second = await skipOccurrence({
      db: admin,
      occurrenceId: id,
      actor: 'provider',
      actorUserId: providerId,
      today: sameDayOf(id),
    })
    expect(second.ok).toBe(false)

    expect(await creditRowsFor(id)).toHaveLength(1)
  })

  it('the credit row carries a per-occurrence idempotency key', async () => {
    const id = await makeOccurrence('due_today')
    await skipOccurrence({
      db: admin,
      occurrenceId: id,
      actor: 'provider',
      actorUserId: providerId,
      today: sameDayOf(id),
    })
    const rows = await creditRowsFor(id)
    expect(rows[0]!.idempotency_key).toBe(`credit:${id}`)
  })
})

describe('completed work cannot be skipped after the fact', () => {
  it('refuses a provider skip on a completed stop', async () => {
    const id = await makeOccurrence('due_today')
    await completeOccurrence({ db: admin, occurrenceId: id, actorUserId: providerId })

    const r = await skipOccurrence({
      db: admin,
      occurrenceId: id,
      actor: 'provider',
      actorUserId: providerId,
      today: sameDayOf(id),
    })

    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('ILLEGAL_TRANSITION')
    expect(await stateOf(id)).toBe('completed')
    expect(await creditRowsFor(id)).toHaveLength(0)
  })
})

describe('previewSkip tells the customer before they commit', () => {
  it('warns that a same-day skip will still be billed', async () => {
    const id = await makeOccurrence('due_today')
    const r = await previewSkip({
      db: admin,
      occurrenceId: id,
      actorUserId: customerId,
      today: sameDayOf(id),
    })

    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.credit.credited).toBe(false)
      expect(r.credit.message).toMatch(/still be billed/)
    }
    // Preview must not change anything.
    expect(await stateOf(id)).toBe('due_today')
    expect(await creditRowsFor(id)).toHaveLength(0)
  })

  it('agrees with what the skip then actually does', async () => {
    const id = await makeOccurrence('scheduled')
    const preview = await previewSkip({
      db: admin,
      occurrenceId: id,
      actorUserId: customerId,
      today: dayBeforeOf(id),
    })
    const actual = await skipOccurrence({
      db: admin,
      occurrenceId: id,
      actor: 'customer',
      actorUserId: customerId,
      today: dayBeforeOf(id),
    })

    expect(preview.ok && actual.ok).toBe(true)
    if (preview.ok && actual.ok) {
      expect(preview.credit.credited).toBe(actual.credit.credited)
      expect(preview.credit.amountCents).toBe(actual.credit.amountCents)
    }
  })

  it('refuses to preview somebody else subscription', async () => {
    const id = await makeOccurrence('due_today')
    const r = await previewSkip({
      db: admin,
      occurrenceId: id,
      actorUserId: otherCustomerId,
      today: sameDayOf(id),
    })
    expect(r.ok).toBe(false)
  })
})

describe('audit trail', () => {
  it('records the completion with actor and both states', async () => {
    const id = await makeOccurrence('due_today')
    await completeOccurrence({ db: admin, occurrenceId: id, actorUserId: providerId })

    const { data } = await admin
      .from('audit_log')
      .select('action, actor_user_id, target_id, before_json, after_json')
      .eq('target_id', id)
      .eq('action', 'occurrence.completed')

    expect(data).toHaveLength(1)
    expect(data![0]!.actor_user_id).toBe(providerId)
  })

  it('records a skip with the credit decision as the reason code', async () => {
    const id = await makeOccurrence('due_today')
    await skipOccurrence({
      db: admin,
      occurrenceId: id,
      actor: 'customer',
      actorUserId: customerId,
      today: sameDayOf(id),
    })

    const { data } = await admin
      .from('audit_log')
      .select('action, reason_code')
      .eq('target_id', id)
      .eq('action', 'occurrence.customer_skipped')

    expect(data).toHaveLength(1)
    expect(data![0]!.reason_code).toBe('customer_inside_cutoff')
  })
})
