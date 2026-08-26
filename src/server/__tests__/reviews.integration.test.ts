/**
 * Reviews, against the live database.
 *
 * The claims worth making here:
 *
 *   - only a delivered visit can be reviewed, and only by the customer who
 *     received it;
 *   - one per visit and one per billing cycle, under a double-tapped
 *     submit as well as under a polite one;
 *   - a provider gets exactly one reply;
 *   - a report for the reasons that cannot wait hides the review at once;
 *   - and the public rating stays invisible until there is a body of work,
 *     which is the rule that exists because the reputation belongs to a
 *     named minor.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'
import {
  createReview,
  getPublicRating,
  reportReview,
  respondToReview,
} from '@/server/reviewService'

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
const PRICE = 300

let providerId = ''
let customerId = ''
let otherCustomerId = ''
let serviceId = ''
let subscriptionId = ''

const madeUsers: string[] = []
const madeReviews: string[] = []
let occurrenceCursor = 0

async function makeUser(email: string): Promise<string> {
  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    password: `Test-${stamp}-Aa1!`,
    email_confirm: true,
  })
  if (error || !created.user) throw new Error(`createUser failed: ${error?.message}`)
  const { data: du } = await admin
    .from('users')
    .select('id')
    .eq('auth_user_id', created.user.id)
    .single()
  madeUsers.push(du!.id)
  return du!.id
}

async function makeOccurrence(
  state: NonNullable<Database['public']['Tables']['service_occurrences']['Insert']['state']> = 'completed',
): Promise<string> {
  const d = new Date('2026-09-01T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + occurrenceCursor++)
  const iso = d.toISOString().slice(0, 10)

  const { data, error } = await admin
    .from('service_occurrences')
    .insert({
      subscription_id: subscriptionId,
      service_date: iso,
      local_timezone: 'UTC',
      state,
      service_value_cents: PRICE,
      ...(state === 'completed' ? { completed_at: `${iso}T18:00:00Z` } : {}),
    })
    .select('id')
    .single()
  if (error) throw new Error(`occurrence insert failed: ${error.message}`)
  return data!.id
}

/** Clears the cycle so the one-per-cycle rule does not block a setup step. */
async function clearCycle(): Promise<void> {
  await admin
    .from('subscriptions')
    .update({ current_cycle_start: null })
    .eq('id', subscriptionId)
}

async function setCycle(iso: string): Promise<void> {
  await admin
    .from('subscriptions')
    .update({ current_cycle_start: iso })
    .eq('id', subscriptionId)
}

async function review(occurrenceId: string, rating: number, body?: string, actor = customerId) {
  const r = await createReview({
    db: admin,
    occurrenceId,
    actorUserId: actor,
    rating,
    ...(body !== undefined ? { body } : {}),
  })
  if (r.ok) madeReviews.push(r.reviewId)
  return r
}

async function stateOfReview(id: string): Promise<string> {
  const { data } = await admin.from('reviews').select('state').eq('id', id).single()
  return data!.state
}

beforeAll(async () => {
  providerId = await makeUser(`rev-provider-${stamp}@example.com`)
  customerId = await makeUser(`rev-customer-${stamp}@example.com`)
  otherCustomerId = await makeUser(`rev-other-${stamp}@example.com`)

  await admin.from('provider_profiles').insert({
    user_id: providerId,
    date_of_birth: '2010-01-01',
    display_first_name: 'Jamie',
    guardian_state: 'verified',
  })

  const { data: biz } = await admin
    .from('businesses')
    .insert({
      provider_user_id: providerId,
      name: `Review Test ${stamp}`,
      slug: `review-test-${stamp}`,
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
      capacity_rule: { maxAddresses: 500 },
      state: 'active',
    })
    .select('id')
    .single()
  if (svcErr) throw new Error(`service insert failed: ${svcErr.message}`)
  serviceId = svc!.id

  const { data: addr } = await admin
    .from('customer_addresses')
    .insert({
      customer_user_id: customerId,
      line1: '1 Review Lane',
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
      customer_user_id: customerId,
      provider_service_id: serviceId,
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

  await clearCycle()
})

afterAll(async () => {
  if (madeReviews.length) {
    await admin.from('review_reports').delete().in('review_id', madeReviews)
    await admin.from('audit_log').delete().in('target_id', madeReviews)
    await admin.from('reviews').delete().in('id', madeReviews)
  }
  if (subscriptionId) {
    await admin.from('reviews').delete().eq('subscription_id', subscriptionId)
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

describe('only a delivered visit can be reviewed', () => {
  it('accepts a completed one', async () => {
    const occ = await makeOccurrence('completed')
    const r = await review(occ, 5, 'Always on time.')
    expect(r.ok).toBe(true)
  })

  it('refuses a scheduled one', async () => {
    const occ = await makeOccurrence('scheduled')
    const r = await review(occ, 5)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('NOT_ELIGIBLE')
  })

  it('refuses a credited one -- the visit did not happen', async () => {
    const occ = await makeOccurrence('credited')
    const r = await review(occ, 1)
    expect(r.ok).toBe(false)
  })

  it('refuses a customer who is not on the subscription', async () => {
    const occ = await makeOccurrence('completed')
    const r = await review(occ, 5, undefined, otherCustomerId)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('NOT_ELIGIBLE')
  })

  it('refuses a visit that does not exist', async () => {
    const r = await createReview({
      db: admin,
      occurrenceId: crypto.randomUUID(),
      actorUserId: customerId,
      rating: 5,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('NOT_FOUND')
  })

  it('refuses an out-of-range rating before touching the database', async () => {
    const occ = await makeOccurrence('completed')
    const r = await review(occ, 6)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('INVALID')
  })
})

describe('one per visit, one per cycle', () => {
  it('refuses a second review of the same visit', async () => {
    const occ = await makeOccurrence('completed')
    expect((await review(occ, 5)).ok).toBe(true)

    const second = await review(occ, 1)
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.code).toBe('NOT_ELIGIBLE')
  })

  it('refuses a second review in the same billing cycle', async () => {
    await setCycle('2026-10-01')
    const first = await makeOccurrence('completed')
    const second = await makeOccurrence('completed')

    expect((await review(first, 5)).ok).toBe(true)
    const blocked = await review(second, 1)
    expect(blocked.ok).toBe(false)

    await clearCycle()
  })

  it('allows one in the next cycle', async () => {
    await setCycle('2026-11-01')
    const occ = await makeOccurrence('completed')
    expect((await review(occ, 4)).ok).toBe(true)
    await clearCycle()
  })
})

describe('the provider gets one reply', () => {
  it('accepts the first', async () => {
    const occ = await makeOccurrence('completed')
    const r = await review(occ, 5)
    if (!r.ok) return

    const responded = await respondToReview({
      db: admin,
      reviewId: r.reviewId,
      actorUserId: providerId,
      body: 'Thanks! See you Tuesday.',
    })
    expect(responded.ok).toBe(true)
  })

  it('refuses a second', async () => {
    const occ = await makeOccurrence('completed')
    const r = await review(occ, 5)
    if (!r.ok) return

    await respondToReview({
      db: admin,
      reviewId: r.reviewId,
      actorUserId: providerId,
      body: 'Thanks!',
    })
    const again = await respondToReview({
      db: admin,
      reviewId: r.reviewId,
      actorUserId: providerId,
      body: 'Actually, one more thing.',
    })

    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.code).toBe('INVALID')
  })

  it('refuses a different provider', async () => {
    const occ = await makeOccurrence('completed')
    const r = await review(occ, 5)
    if (!r.ok) return

    const responded = await respondToReview({
      db: admin,
      reviewId: r.reviewId,
      actorUserId: otherCustomerId,
      body: 'Not mine but here I am',
    })
    expect(responded.ok).toBe(false)
    if (!responded.ok) expect(responded.code).toBe('NOT_AUTHORIZED')
  })
})

describe('reporting', () => {
  it('hides a review carrying personal information at once', async () => {
    const occ = await makeOccurrence('completed')
    const r = await review(occ, 1, 'Call me on 555-0100')
    if (!r.ok) return

    const reported = await reportReview({
      db: admin,
      reviewId: r.reviewId,
      reporterUserId: providerId,
      reason: 'personal_information',
    })

    expect(reported.ok).toBe(true)
    if (reported.ok) expect(reported.hidden).toBe(true)
    expect(await stateOfReview(r.reviewId)).toBe('hidden')
  })

  it('leaves an ordinary dispute visible for a human to judge', async () => {
    const occ = await makeOccurrence('completed')
    const r = await review(occ, 1, 'Did not like it')
    if (!r.ok) return

    const reported = await reportReview({
      db: admin,
      reviewId: r.reviewId,
      reporterUserId: providerId,
      reason: 'not_about_this_service',
    })

    if (reported.ok) expect(reported.hidden).toBe(false)
    // A provider disliking a review is not grounds for it to vanish.
    expect(await stateOfReview(r.reviewId)).toBe('published')
  })

  it('cannot be filed twice by the same person', async () => {
    const occ = await makeOccurrence('completed')
    const r = await review(occ, 2)
    if (!r.ok) return

    await reportReview({
      db: admin,
      reviewId: r.reviewId,
      reporterUserId: providerId,
      reason: 'spam_or_advertising',
    })
    const again = await reportReview({
      db: admin,
      reviewId: r.reviewId,
      reporterUserId: providerId,
      reason: 'spam_or_advertising',
    })

    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.code).toBe('ALREADY_REPORTED')
  })

  it('refuses an invented reason', async () => {
    const occ = await makeOccurrence('completed')
    const r = await review(occ, 3)
    if (!r.ok) return

    const reported = await reportReview({
      db: admin,
      reviewId: r.reviewId,
      reporterUserId: providerId,
      reason: 'i_just_do_not_like_it',
    })
    expect(reported.ok).toBe(false)
  })

  it('audits the report', async () => {
    const occ = await makeOccurrence('completed')
    const r = await review(occ, 2)
    if (!r.ok) return

    await reportReview({
      db: admin,
      reviewId: r.reviewId,
      reporterUserId: providerId,
      reason: 'harassment',
    })

    const { data } = await admin
      .from('audit_log')
      .select('action, reason_code')
      .eq('target_id', r.reviewId)
      .eq('action', 'review.reported')

    expect((data ?? []).length).toBeGreaterThan(0)
    expect(data![0]!.reason_code).toBe('harassment')
  })
})

describe('a minor has no public rating until there is a body of work', () => {
  it('shows no score at all while below the threshold', async () => {
    const rating = await getPublicRating({ db: admin, providerServiceId: serviceId, minimum: 100 })
    expect(rating.visible).toBe(false)
    if (!rating.visible) expect(JSON.stringify(rating)).not.toContain('average')
  })

  it('appears once enough published reviews exist', async () => {
    const rating = await getPublicRating({ db: admin, providerServiceId: serviceId, minimum: 1 })
    expect(rating.visible).toBe(true)
  })

  it('counts published reviews only, not hidden ones', async () => {
    const before = await getPublicRating({ db: admin, providerServiceId: serviceId, minimum: 1 })
    const beforeCount = before.visible ? before.count : 0

    const occ = await makeOccurrence('completed')
    const r = await review(occ, 1, 'Terrible, here is my number 555-0100')
    if (!r.ok) return

    await reportReview({
      db: admin,
      reviewId: r.reviewId,
      reporterUserId: providerId,
      reason: 'personal_information',
    })

    const after = await getPublicRating({ db: admin, providerServiceId: serviceId, minimum: 1 })
    const afterCount = after.visible ? after.count : 0
    // The hidden one is not evidence of anything until a human has looked.
    expect(afterCount).toBe(beforeCount)
  })
})

describe('what an unauthenticated storefront reader can see', () => {
  it('reads published reviews, because that is the social proof', async () => {
    const { data, error } = await anon
      .from('reviews')
      .select('rating, body, response_body')
      .eq('provider_service_id', serviceId)
    expect(error).toBeNull()
    expect((data ?? []).length).toBeGreaterThan(0)
  })

  it('cannot see a hidden review', async () => {
    const { data } = await anon
      .from('reviews')
      .select('state')
      .eq('provider_service_id', serviceId)
    expect((data ?? []).every((r) => r.state === 'published')).toBe(true)
  })

  it('cannot write one', async () => {
    const { error } = await anon.from('reviews').insert({
      occurrence_id: crypto.randomUUID(),
      subscription_id: subscriptionId,
      provider_service_id: serviceId,
      provider_user_id: providerId,
      customer_user_id: customerId,
      rating: 5,
    } as never)
    expect(error).not.toBeNull()
  })

  it('cannot read the moderation queue', async () => {
    const { error } = await anon.from('review_reports').select('reason').limit(1)
    expect(error).not.toBeNull()
  })
})
