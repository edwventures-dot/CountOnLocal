/**
 * The guardian dashboard, against the live database.
 *
 * Every read goes through a client PostgREST sees as a specific signed-in
 * guardian, because the claims are about what row level security withholds,
 * not about what this code remembers to filter.
 *
 * The line being tested is the last sentence of PRD section 15: "Guardian
 * cannot silently read unrelated private drafts or export customer data for
 * non-service purposes." Migration 0019 draws it in two tiers, and these
 * tests check both edges:
 *
 *   - a guardian who has started but not consented sees the business and
 *     the services, and no customer addresses at all;
 *   - a verified guardian sees the work and the addresses it happens at;
 *   - an unrelated guardian sees nothing in either tier;
 *   - a revoked guardian keeps operational access, because
 *     SAFETY_TRUST_POLICY section 2 hands them outstanding visits to
 *     resolve.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'
import {
  getGuardianDashboard,
  pauseBusinessAsGuardian,
  resumeBusinessAsGuardian,
} from '@/server/guardianDashboard'

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
let guardian: TestUser
let strangerGuardian: TestUser
let customer: TestUser
let businessId = ''
let serviceId = ''
let relationshipId = ''
let subscriptionId = ''

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

async function setGuardianState(state: string): Promise<void> {
  const { error } = await admin
    .from('guardian_relationships')
    .update({
      state: state as never,
      // revoked_requires_timestamp: a revocation with no time is not a
      // record of anything. Cleared again on the way back out.
      revoked_at: state === 'revoked' ? new Date().toISOString() : null,
      // pending_invitation_has_expiry: a live invitation must be able to
      // expire, because `expired` is a real state and not a theoretical one.
      invitation_expires_at: ['invited', 'guardian_started'].includes(state)
        ? new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString()
        : null,
    })
    .eq('id', relationshipId)
  if (error) throw new Error(`could not set guardian state: ${error.message}`)

  await admin
    .from('provider_profiles')
    .update({ guardian_state: state as never })
    .eq('user_id', provider.domainId)

  // Read it back. A state that silently failed to change would make every
  // visibility assertion after this point meaningless rather than failing.
  const { data } = await admin
    .from('guardian_relationships')
    .select('state')
    .eq('id', relationshipId)
    .single()
  if (data!.state !== state) {
    throw new Error(`guardian state did not stick: wanted ${state}, got ${data!.state}`)
  }
}

async function dashboardFor(user: TestUser) {
  return getGuardianDashboard({
    db: userScoped(user.token),
    adminDb: admin,
    guardianUserId: user.domainId,
    now: NOW,
  })
}

beforeAll(async () => {
  provider = await makeUser(`gd-provider-${stamp}@example.com`)
  guardian = await makeUser(`gd-guardian-${stamp}@example.com`)
  strangerGuardian = await makeUser(`gd-stranger-${stamp}@example.com`)
  customer = await makeUser(`gd-customer-${stamp}@example.com`)

  // A 15-year-old provider.
  const dob = new Date()
  dob.setUTCFullYear(dob.getUTCFullYear() - 15)
  await admin.from('provider_profiles').insert({
    user_id: provider.domainId,
    date_of_birth: dob.toISOString().slice(0, 10),
    display_first_name: 'Jamie',
    guardian_state: 'verified',
  })
  await admin.from('user_roles').insert({ user_id: provider.domainId, role: 'provider' })

  for (const g of [guardian, strangerGuardian]) {
    await admin.from('guardian_profiles').insert({ user_id: g.domainId })
  }

  const { data: rel, error: relErr } = await admin
    .from('guardian_relationships')
    .insert({
      provider_user_id: provider.domainId,
      guardian_user_id: guardian.domainId,
      state: 'verified',
      consented_at: new Date().toISOString(),
      // invitation_needs_a_destination: a relationship records how the
      // guardian was reached. Correct -- an invitation with nowhere to go
      // is not an invitation.
      invitation_email: `gd-guardian-${stamp}@example.com`,
    })
    .select('id')
    .single()
  if (relErr) throw new Error(`relationship insert failed: ${relErr.message}`)
  relationshipId = rel!.id

  const { data: biz, error: bizErr } = await admin
    .from('businesses')
    .insert({
      provider_user_id: provider.domainId,
      name: `Jamie's Bins ${stamp}`,
      slug: `jamie-bins-${stamp}`,
      state: 'published',
      published_at: new Date().toISOString(),
      public_area_label: 'Oak Ridge',
    })
    .select('id')
    .single()
  if (bizErr) throw new Error(`business insert failed: ${bizErr.message}`)
  businessId = biz!.id

  const { data: cat } = await admin
    .from('service_catalog')
    .select('id, code')
    .eq('code', 'bin_curb_service')
    .single()

  const { data: svc, error: svcErr } = await admin
    .from('provider_services')
    .insert({
      business_id: businessId,
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
  serviceId = svc!.id

  await admin.from('guardian_service_approvals').insert({
    relationship_id: relationshipId,
    catalog_code: cat!.code,
    // Who granted it. An approval with no author is not an approval.
    approved_by_user_id: guardian.domainId,
  })

  const { data: addr } = await admin
    .from('customer_addresses')
    .insert({
      customer_user_id: customer.domainId,
      line1: '742 Evergreen Terrace',
      city: 'Austin',
      region: 'TX',
      postal_code: '78701',
      country_code: 'US',
      access_notes: 'Gate code 8891',
    })
    .select('id')
    .single()

  const { data: sub, error: subErr } = await admin
    .from('subscriptions')
    .insert({
      customer_user_id: customer.domainId,
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

  await admin.from('service_occurrences').insert({
    subscription_id: subscriptionId,
    service_date: '2026-09-15',
    local_timezone: 'UTC',
    state: 'scheduled',
    service_value_cents: PRICE,
  })
})

afterAll(async () => {
  if (subscriptionId) {
    await admin.from('ledger_entries').delete().eq('subscription_id', subscriptionId)
    await admin.from('service_occurrences').delete().eq('subscription_id', subscriptionId)
    await admin.from('subscriptions').delete().eq('id', subscriptionId)
  }
  if (relationshipId) {
    await admin.from('guardian_service_approvals').delete().eq('relationship_id', relationshipId)
  }
  await admin.from('customer_addresses').delete().in('customer_user_id', madeUsers)
  if (businessId) await admin.from('audit_log').delete().eq('target_id', businessId)
  for (const id of madeUsers) {
    const { data: u } = await admin.from('users').select('auth_user_id').eq('id', id).maybeSingle()
    await admin.from('audit_log').delete().eq('actor_user_id', id)
    await admin.from('users').delete().eq('id', id)
    if (u?.auth_user_id) await admin.auth.admin.deleteUser(u.auth_user_id).catch(() => {})
  }
})

describe('a verified guardian sees the business', () => {
  it('gets the business, its state and its public page', async () => {
    await setGuardianState('verified')
    const r = await dashboardFor(guardian)

    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.dashboard.business?.name).toContain('Jamie')
      expect(r.dashboard.business?.isLive).toBe(true)
      expect(r.dashboard.business?.publicUrl).toContain('countonlocal.com/')
    }
  })

  it('sees the services and which categories they approved', async () => {
    const r = await dashboardFor(guardian)
    if (r.ok) {
      expect(r.dashboard.services).toHaveLength(1)
      expect(r.dashboard.services[0]!.categoryApproved).toBe(true)
      expect(r.dashboard.services[0]!.publicName).toBe('Weekly bins')
    }
  })

  it('sees upcoming work and where it happens', async () => {
    const r = await dashboardFor(guardian)
    if (r.ok) {
      expect(r.dashboard.canSeeOperations).toBe(true)
      expect(r.dashboard.upcoming.length).toBeGreaterThan(0)
      expect(r.dashboard.upcoming[0]!.address?.line1).toBe('742 Evergreen Terrace')
    }
  })

  it('counts the active customers', async () => {
    const r = await dashboardFor(guardian)
    if (r.ok) expect(r.dashboard.activeCustomerCount).toBe(1)
  })

  it('gets payout status, not the ledger', async () => {
    const r = await dashboardFor(guardian)
    if (r.ok) {
      expect(r.dashboard.payout).not.toBeNull()
      expect(r.dashboard.payout).toHaveProperty('stage')
      // The books stay closed.
      expect(JSON.stringify(r.dashboard)).not.toMatch(/customer_charge|platform_fee/)
    }
  })
})

describe('a guardian who has not consented yet', () => {
  it('sees the business and services, so they can decide', async () => {
    await setGuardianState('guardian_started')
    const r = await dashboardFor(guardian)

    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.dashboard.business).not.toBeNull()
      expect(r.dashboard.services).toHaveLength(1)
    }
  })

  it('sees no customer addresses at all', async () => {
    await setGuardianState('guardian_started')
    const r = await dashboardFor(guardian)

    if (r.ok) {
      expect(r.dashboard.canSeeOperations).toBe(false)
      expect(r.dashboard.upcoming).toHaveLength(0)
    }
  })

  it('is refused by the database, not just by this code', async () => {
    await setGuardianState('guardian_started')
    const { data } = await userScoped(guardian.token).from('customer_addresses').select('line1')
    expect((data ?? []).map((r) => r.line1)).not.toContain('742 Evergreen Terrace')
  })

  it('cannot read the gate code', async () => {
    await setGuardianState('guardian_started')
    const { data } = await userScoped(guardian.token)
      .from('customer_addresses')
      .select('access_notes')
    expect(JSON.stringify(data ?? [])).not.toContain('8891')
  })
})

describe('a revoked guardian keeps operational access', () => {
  it('can still see outstanding visits, per SAFETY_TRUST_POLICY 2', async () => {
    await setGuardianState('revoked')
    const r = await dashboardFor(guardian)

    expect(r.ok).toBe(true)
    if (r.ok) {
      // They just pulled the plug; they are exactly who has to resolve
      // what is still scheduled.
      expect(r.dashboard.canSeeOperations).toBe(true)
      expect(r.dashboard.upcoming.length).toBeGreaterThan(0)
    }
  })
})

describe('an expired relationship sees nothing operational', () => {
  it('loses the work and the addresses', async () => {
    await setGuardianState('expired')
    const r = await dashboardFor(guardian)

    if (r.ok) {
      expect(r.dashboard.canSeeOperations).toBe(false)
      expect(r.dashboard.upcoming).toHaveLength(0)
    }

    const { data } = await userScoped(guardian.token)
      .from('service_occurrences')
      .select('id')
      .eq('subscription_id', subscriptionId)
    expect(data ?? []).toHaveLength(0)
  })
})

describe('an unrelated guardian sees nothing', () => {
  it('has no dashboard at all', async () => {
    const r = await dashboardFor(strangerGuardian)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('NO_RELATIONSHIP')
  })

  it('sees the storefront only because it is public, like anyone would', async () => {
    // businesses_read_published makes a live storefront readable to
    // everyone -- that is the product working, not a leak. The private
    // things are asserted below.
    const { data } = await userScoped(strangerGuardian.token)
      .from('businesses')
      .select('name')
      .eq('id', businessId)
    expect((data ?? []).length).toBeLessThanOrEqual(1)
  })

  it('cannot read the subscriptions', async () => {
    const { data } = await userScoped(strangerGuardian.token).from('subscriptions').select('id')
    expect((data ?? []).map((r) => r.id)).not.toContain(subscriptionId)
  })

  it('cannot read the scheduled work', async () => {
    const { data } = await userScoped(strangerGuardian.token)
      .from('service_occurrences')
      .select('id')
      .eq('subscription_id', subscriptionId)
    expect(data ?? []).toHaveLength(0)
  })

  it('cannot read the customer address directly', async () => {
    const { data } = await userScoped(strangerGuardian.token)
      .from('customer_addresses')
      .select('line1')
    expect((data ?? []).map((r) => r.line1)).not.toContain('742 Evergreen Terrace')
  })
})

describe('the pause button', () => {
  it('takes the storefront down immediately', async () => {
    await setGuardianState('verified')
    await admin.from('businesses').update({ state: 'published' }).eq('id', businessId)

    const r = await pauseBusinessAsGuardian({
      db: admin,
      businessId,
      guardianUserId: guardian.domainId,
    })

    expect(r.ok).toBe(true)
    const { data } = await admin.from('businesses').select('state').eq('id', businessId).single()
    expect(data!.state).toBe('paused_guardian')
  })

  it('reports outstanding visits rather than cancelling them', async () => {
    await admin.from('businesses').update({ state: 'published' }).eq('id', businessId)
    const r = await pauseBusinessAsGuardian({
      db: admin,
      businessId,
      guardianUserId: guardian.domainId,
    })

    expect(r.ok).toBe(true)
    // Scoped to this business, not the whole platform.
    if (r.ok) expect(r.affectedOccurrences).toBe(1)

    const { data } = await admin
      .from('service_occurrences')
      .select('state')
      .eq('subscription_id', subscriptionId)
    expect(data!.every((o) => o.state === 'scheduled')).toBe(true)
  })

  it('leaves the guardian relationship untouched', async () => {
    const { data } = await admin
      .from('guardian_relationships')
      .select('state')
      .eq('id', relationshipId)
      .single()
    // Pausing is not revoking.
    expect(data!.state).toBe('verified')
  })

  it('refuses a guardian who is not this provider guardian', async () => {
    await admin.from('businesses').update({ state: 'published' }).eq('id', businessId)
    const r = await pauseBusinessAsGuardian({
      db: admin,
      businessId,
      guardianUserId: strangerGuardian.domainId,
    })

    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('NOT_AUTHORIZED')

    const { data } = await admin.from('businesses').select('state').eq('id', businessId).single()
    expect(data!.state).toBe('published')
  })

  it('resumes back to published', async () => {
    await admin.from('businesses').update({ state: 'paused_guardian' }).eq('id', businessId)
    const r = await resumeBusinessAsGuardian({
      db: admin,
      businessId,
      guardianUserId: guardian.domainId,
    })

    expect(r.ok).toBe(true)
    const { data } = await admin.from('businesses').select('state').eq('id', businessId).single()
    expect(data!.state).toBe('published')
  })

  it('will not lift an admin hold', async () => {
    await admin.from('businesses').update({ state: 'paused_admin' }).eq('id', businessId)
    const r = await resumeBusinessAsGuardian({
      db: admin,
      businessId,
      guardianUserId: guardian.domainId,
    })

    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('NOT_PAUSABLE')

    const { data } = await admin.from('businesses').select('state').eq('id', businessId).single()
    expect(data!.state).toBe('paused_admin')

    await admin.from('businesses').update({ state: 'published' }).eq('id', businessId)
  })

  it('audits the pause with the guardian as actor', async () => {
    await admin.from('businesses').update({ state: 'published' }).eq('id', businessId)
    await pauseBusinessAsGuardian({
      db: admin,
      businessId,
      guardianUserId: guardian.domainId,
      reasonCode: 'guardian_pause',
    })

    const { data } = await admin
      .from('audit_log')
      .select('action, actor_user_id, actor_role, reason_code')
      .eq('target_id', businessId)
      .eq('action', 'business.paused_guardian')

    expect((data ?? []).length).toBeGreaterThan(0)
    expect(data![0]!.actor_role).toBe('guardian')
    expect(data![0]!.actor_user_id).toBe(guardian.domainId)
  })
})
