/**
 * Business and service builder, against the live database.
 *
 * The claims that matter here are the catalog ones: a provider cannot invent
 * a category, cannot widen an approved one through free text, and cannot
 * publish before guardian consent and payout readiness both hold.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'
import { startProviderOnboarding } from '@/server/providerOnboarding'
import { createGuardianInvitation, acceptGuardianInvitation } from '@/server/guardianService'
import { createBusiness, addService, publishBusiness } from '@/server/businessService'

const url = process.env['NEXT_PUBLIC_SUPABASE_URL']!
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY']!
const anonKey = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!

const admin = createClient<Database>(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})
const anon = createClient<Database>(url, anonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

type TestUser = { authId: string; domainId: string; email: string }

const stamp = Date.now()
const PROVIDER_EMAIL = `biz-provider-${stamp}@example.com`
const GUARDIAN_EMAIL = `biz-guardian-${stamp}@example.com`
const PASSWORD = `Test-${stamp}-Aa1!`

async function makeUser(email: string): Promise<TestUser> {
  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  })
  if (error || !created.user) throw new Error(`createUser failed: ${error?.message}`)
  const { data: du, error: readErr } = await admin
    .from('users')
    .select('id')
    .eq('auth_user_id', created.user.id)
    .single()
  if (readErr || !du) throw new Error(`not provisioned: ${readErr?.message}`)
  return { authId: created.user.id, domainId: du.id, email }
}

function dobForAge(years: number): string {
  const d = new Date()
  d.setUTCFullYear(d.getUTCFullYear() - years)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

const SCHEDULE = { frequency: 'weekly', weekday: 'tuesday', window: '08:00-18:00' }
const CAPACITY = { maxAddresses: 30 }

let provider: TestUser
let guardian: TestUser
let relationshipId = ''
let businessId = ''
let businessSlug = ''
let binServiceId = ''

beforeAll(async () => {
  provider = await makeUser(PROVIDER_EMAIL)
  guardian = await makeUser(GUARDIAN_EMAIL)

  await startProviderOnboarding({
    db: admin,
    userId: provider.domainId,
    input: { dateOfBirth: dobForAge(15), countryCode: 'US', displayFirstName: 'Jamie' },
    now: new Date(),
  })
  const invite = await createGuardianInvitation({
    db: admin,
    providerUserId: provider.domainId,
    input: { email: GUARDIAN_EMAIL },
    now: new Date(),
  })
  if (!invite.ok) throw new Error('invite failed')
  relationshipId = invite.relationshipId
  await acceptGuardianInvitation({
    adminDb: admin,
    token: invite.token,
    guardianUserId: guardian.domainId,
    now: new Date(),
  })
})

afterAll(async () => {
  for (const u of [provider, guardian]) {
    if (!u) continue
    await admin.from('audit_log').delete().eq('actor_user_id', u.domainId)
    await admin.from('users').delete().eq('id', u.domainId)
    await admin.auth.admin.deleteUser(u.authId)
  }
  if (businessId) await admin.from('audit_log').delete().eq('target_id', businessId)
})

describe('creating a business', () => {
  it('drafts before the guardian is verified', async () => {
    // SAFETY_TRUST_POLICY section 2: a minor may build their page while
    // consent is pending. Only publishing is gated.
    const result = await createBusiness({
      db: admin,
      providerUserId: provider.domainId,
      input: { name: "Jamie's Bin Service", publicAreaLabel: 'Oak Ridge' },
      now: new Date(),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    businessId = result.businessId
    businessSlug = result.slug
    expect(result.slug).toBe('jamies-bin-service')
  })

  it('is invisible to the public while it is a draft', async () => {
    const { data } = await anon.from('businesses').select('id').eq('id', businessId)
    expect(data ?? []).toHaveLength(0)
  })

  it('refuses a reserved slug', async () => {
    const result = await createBusiness({
      db: admin,
      providerUserId: provider.domainId,
      input: { name: 'Admin', slug: 'admin' },
      now: new Date(),
    })
    expect(result).toEqual({ ok: false, code: 'SLUG_UNAVAILABLE' })
  })
})

describe('the catalog is an allowlist', () => {
  it('refuses a category that does not exist', async () => {
    const result = await addService({
      db: admin,
      providerUserId: provider.domainId,
      businessId,
      input: {
        catalogCode: 'chainsaw_tree_trimming',
        publicName: 'Tree work',
        description: 'I will trim your trees for you every month.',
        priceCents: 5000,
        priceUnit: 'visit',
        billingCycleWeeks: 4,
        scheduleRule: SCHEDULE,
        capacityRule: CAPACITY,
        providerLimits: {},
      },
      now: new Date(),
    })
    expect(result).toEqual({ ok: false, code: 'UNKNOWN_CATALOG_SERVICE' })
  })

  it('accepts a Tier A service for a guardian-pending minor once verified', async () => {
    await admin
      .from('guardian_relationships')
      .update({ state: 'verified', consented_at: new Date().toISOString() })
      .eq('id', relationshipId)
    await admin
      .from('provider_profiles')
      .update({ guardian_state: 'verified' })
      .eq('user_id', provider.domainId)

    const result = await addService({
      db: admin,
      providerUserId: provider.domainId,
      businessId,
      input: {
        catalogCode: 'bin_curb_service',
        publicName: 'Curb-to-house return',
        description:
          'I return your trash and recycling cans from the curb to your usual outside spot every Tuesday.',
        priceCents: 300,
        priceUnit: 'week',
        billingCycleWeeks: 4,
        scheduleRule: SCHEDULE,
        capacityRule: CAPACITY,
        providerLimits: {},
      },
      now: new Date(),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    binServiceId = result.serviceId
  })

  it('stores the price as integer cents', async () => {
    const { data } = await admin
      .from('provider_services')
      .select('price_cents, price_unit')
      .eq('id', binServiceId)
      .single()
    expect(data?.price_cents).toBe(300)
    expect(Number.isInteger(data?.price_cents)).toBe(true)
    expect(data?.price_unit).toBe('week')
  })

  it('refuses a Tier B category the guardian has not approved', async () => {
    const result = await addService({
      db: admin,
      providerUserId: provider.domainId,
      businessId,
      input: {
        catalogCode: 'dog_walking',
        publicName: 'Neighbourhood walks',
        description: 'Recurring walks for friendly dogs on weekday afternoons.',
        priceCents: 1200,
        priceUnit: 'visit',
        billingCycleWeeks: 4,
        scheduleRule: SCHEDULE,
        capacityRule: CAPACITY,
        providerLimits: { maxDogs: 2 },
      },
      now: new Date(),
    })
    expect(result).toEqual({ ok: false, code: 'CATEGORY_NOT_APPROVED_BY_GUARDIAN' })
  })

  it('accepts it once the guardian approves that category specifically', async () => {
    await admin.from('guardian_service_approvals').insert({
      relationship_id: relationshipId,
      catalog_code: 'dog_walking',
      approved_by_user_id: guardian.domainId,
    })

    const result = await addService({
      db: admin,
      providerUserId: provider.domainId,
      businessId,
      input: {
        catalogCode: 'dog_walking',
        publicName: 'Neighbourhood walks',
        description: 'Recurring walks for friendly dogs on weekday afternoons.',
        priceCents: 1200,
        priceUnit: 'visit',
        billingCycleWeeks: 4,
        scheduleRule: SCHEDULE,
        capacityRule: CAPACITY,
        providerLimits: { maxDogs: 2 },
      },
      now: new Date(),
    })
    expect(result.ok).toBe(true)
  })
})

describe('free text cannot widen an approved service', () => {
  it('refuses the SAFETY_TRUST_POLICY example', async () => {
    const result = await addService({
      db: admin,
      providerUserId: provider.domainId,
      businessId,
      input: {
        catalogCode: 'manual_yard_cleanup',
        publicName: 'Yard help',
        description: 'Raking and hand weeding. I can also do chainsaw tree trimming on request.',
        priceCents: 2000,
        priceUnit: 'visit',
        billingCycleWeeks: 4,
        scheduleRule: SCHEDULE,
        capacityRule: CAPACITY,
        providerLimits: {},
      },
      now: new Date(),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('PROHIBITED_WORDING')
    expect(result.flags?.map((f) => f.reason)).toContain('powered cutting tools')
  })

  it('checks the public name too, not only the description', async () => {
    const result = await addService({
      db: admin,
      providerUserId: provider.domainId,
      businessId,
      input: {
        catalogCode: 'manual_yard_cleanup',
        publicName: 'Lawn mowing and raking',
        description: 'Tidy up the yard on a weekly schedule with hand tools.',
        priceCents: 2000,
        priceUnit: 'visit',
        billingCycleWeeks: 4,
        scheduleRule: SCHEDULE,
        capacityRule: CAPACITY,
        providerLimits: {},
      },
      now: new Date(),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('PROHIBITED_WORDING')
  })

  it('records the refusal for trust and safety', async () => {
    const { data } = await admin
      .from('audit_log')
      .select('action')
      .eq('action', 'service.wording_refused')
      .eq('target_id', businessId)
    expect((data ?? []).length).toBeGreaterThan(0)
  })
})

describe('publishing', () => {
  it('is blocked while payouts are not ready, even with a verified guardian', async () => {
    const result = await publishBusiness({
      db: admin,
      providerUserId: provider.domainId,
      businessId,
      now: new Date(),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.blockers).toContain('PAYOUT_ONBOARDING_INCOMPLETE')
  })

  it('lists every blocker at once, not one per attempt', async () => {
    const result = await publishBusiness({
      db: admin,
      providerUserId: provider.domainId,
      businessId,
      now: new Date(),
    })
    if (result.ok) return
    // No service has an area yet, and none is active.
    expect(result.blockers).toContain('NO_ACTIVE_SERVICE')
    expect((result.blockers ?? []).length).toBeGreaterThan(1)
  })

  it('publishes once guardian, payouts, service, area and label all hold', async () => {
    // Satisfy payouts by mirroring a ready Stripe account onto the guardian.
    await admin
      .from('users')
      .update({
        stripe_connected_account_id: `acct_test_${stamp}`,
        stripe_transfers_active: true,
        stripe_payouts_active: true,
        stripe_requirements_due: [],
      })
      .eq('id', guardian.domainId)
    await admin
      .from('provider_profiles')
      .update({ payout_account_user_id: guardian.domainId })
      .eq('user_id', provider.domainId)

    await admin.from('provider_services').update({ state: 'active' }).eq('id', binServiceId)
    await admin.from('service_areas').insert({
      provider_service_id: binServiceId,
      private_geometry: { type: 'Polygon', coordinates: [[[0, 0], [0, 1], [1, 1], [0, 0]]] },
      public_generalized_geometry: { type: 'Point', coordinates: [0.5, 0.5] },
      label: 'Oak Ridge',
    })
    // The dog-walking service stays draft, so it must not block publish.

    const result = await publishBusiness({
      db: admin,
      providerUserId: provider.domainId,
      businessId,
      now: new Date(),
    })
    expect(result.ok).toBe(true)
  })

  it('refuses to publish twice', async () => {
    const again = await publishBusiness({
      db: admin,
      providerUserId: provider.domainId,
      businessId,
      now: new Date(),
    })
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.blockers).toContain('ALREADY_PUBLISHED')
  })
})

describe('the published storefront is public, the private parts are not', () => {
  it('lets anyone read the published business by slug', async () => {
    const { data } = await anon
      .from('businesses')
      .select('name, slug, public_area_label, state')
      .eq('slug', businessSlug)
      .maybeSingle()
    expect(data?.name).toBe("Jamie's Bin Service")
    expect(data?.state).toBe('published')
  })

  it('exposes only the active service, not the draft one', async () => {
    const { data } = await anon
      .from('provider_services')
      .select('id, public_name, price_cents, state')
      .eq('business_id', businessId)
    expect(data ?? []).toHaveLength(1)
    expect(data?.[0]?.state).toBe('active')
    expect(data?.[0]?.price_cents).toBe(300)
  })

  it('never exposes the private service-area geometry', async () => {
    const { data } = await anon.from('service_areas').select('private_geometry')
    expect(data ?? []).toHaveLength(0)
  })

  it('exposes only the generalized geometry through the public view', async () => {
    const { data } = await anon
      .from('public_service_areas' as never)
      .select('*')
      .eq('provider_service_id', binServiceId)
    const rows = (data ?? []) as unknown as Record<string, unknown>[]
    expect(rows).toHaveLength(1)
    expect(rows[0]).not.toHaveProperty('private_geometry')
    expect(rows[0]).toHaveProperty('public_generalized_geometry')
  })

  it('never exposes the provider identity or date of birth', async () => {
    const { data } = await anon.from('provider_profiles').select('*')
    expect(data ?? []).toHaveLength(0)
  })
})
