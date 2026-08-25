/**
 * The public storefront page, fetched over HTTP as a visitor would.
 *
 * The API tests prove the rules. This proves the page a neighbour actually
 * lands on after scanning a flyer: that it renders, that it shows price and
 * cadence honestly, and that nothing private leaks into the HTML.
 *
 *   npx next dev -p 3100
 *   npm run test:http
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'
import { startProviderOnboarding } from '@/server/providerOnboarding'
import { createGuardianInvitation, acceptGuardianInvitation, revokeGuardianRelationship } from '@/server/guardianService'
import { createBusiness, addService, publishBusiness, setServiceArea } from '@/server/businessService'

const BASE = process.env['E2E_BASE_URL'] ?? 'http://localhost:3100'
const url = process.env['NEXT_PUBLIC_SUPABASE_URL']!
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY']!

const admin = createClient<Database>(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const stamp = Date.now()
const PROVIDER_EMAIL = `store-provider-${stamp}@example.com`
const GUARDIAN_EMAIL = `store-guardian-${stamp}@example.com`
const PASSWORD = `Test-${stamp}-Aa1!`

type TestUser = { authId: string; domainId: string }

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
  return { authId: created.user.id, domainId: du!.id }
}

function dobForAge(years: number): string {
  const d = new Date()
  d.setUTCFullYear(d.getUTCFullYear() - years)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

let provider: TestUser
let guardian: TestUser
let relationshipId = ''
let businessId = ''
let slug = ''
const PRIVATE_GEOMETRY_MARKER = 'PRIVATE-BOUNDARY-MARKER'

beforeAll(async () => {
  const ping = await fetch(BASE + '/').catch(() => null)
  if (!ping) throw new Error(`No dev server at ${BASE}. Start it with: npx next dev -p 3100`)

  provider = await makeUser(PROVIDER_EMAIL)
  guardian = await makeUser(GUARDIAN_EMAIL)
  const now = new Date()

  await startProviderOnboarding({
    db: admin,
    userId: provider.domainId,
    input: { dateOfBirth: dobForAge(15), countryCode: 'US', displayFirstName: 'Jamie' },
    now,
  })
  const invite = await createGuardianInvitation({
    db: admin,
    providerUserId: provider.domainId,
    input: { email: GUARDIAN_EMAIL },
    now,
  })
  if (!invite.ok) throw new Error('invite failed')
  relationshipId = invite.relationshipId
  await acceptGuardianInvitation({
    adminDb: admin,
    token: invite.token,
    guardianUserId: guardian.domainId,
    now,
  })
  await admin
    .from('guardian_relationships')
    .update({ state: 'verified', consented_at: now.toISOString() })
    .eq('id', relationshipId)
  await admin
    .from('provider_profiles')
    .update({ guardian_state: 'verified' })
    .eq('user_id', provider.domainId)

  // A payout-ready guardian account.
  await admin
    .from('users')
    .update({
      stripe_connected_account_id: `acct_store_${stamp}`,
      stripe_transfers_active: true,
      stripe_payouts_active: true,
      stripe_requirements_due: [],
    })
    .eq('id', guardian.domainId)
  await admin
    .from('provider_profiles')
    .update({ payout_account_user_id: guardian.domainId })
    .eq('user_id', provider.domainId)

  const biz = await createBusiness({
    db: admin,
    providerUserId: provider.domainId,
    input: {
      name: `Jamie Bin Service ${stamp}`,
      tagline: 'Your cans are back before the day gets away from you.',
      about: 'Simple recurring service, one predictable day, easy pause and cancel.',
      publicAreaLabel: 'Oak Ridge',
    },
    now,
  })
  if (!biz.ok) throw new Error('business create failed: ' + biz.code)
  businessId = biz.businessId
  slug = biz.slug

  const svc = await addService({
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
      scheduleRule: { frequency: 'weekly', weekday: 'tuesday', window: '8:00 AM - 6:00 PM' },
      capacityRule: { maxAddresses: 30 },
      providerLimits: {},
    },
    now,
  })
  if (!svc.ok) throw new Error('service create failed: ' + svc.code)

  await setServiceArea({
    db: admin,
    providerUserId: provider.domainId,
    providerServiceId: svc.serviceId,
    input: {
      // A recognisable marker so the test can prove it never reaches the HTML.
      privateGeometry: { type: 'Polygon', note: PRIVATE_GEOMETRY_MARKER, coordinates: [] },
      publicGeneralizedGeometry: { type: 'Point', coordinates: [0.5, 0.5] },
      label: 'Oak Ridge',
    },
    now,
  })

  await admin.from('provider_services').update({ state: 'active' }).eq('id', svc.serviceId)

  const published = await publishBusiness({
    db: admin,
    providerUserId: provider.domainId,
    businessId,
    now,
  })
  if (!published.ok) throw new Error('publish failed: ' + JSON.stringify(published))
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

async function getPage(path: string) {
  const res = await fetch(BASE + path, { headers: { 'Cache-Control': 'no-cache' } })
  return { status: res.status, html: await res.text() }
}

describe('the published storefront renders', () => {
  it('serves the page at /{slug}', async () => {
    const { status, html } = await getPage(`/${slug}`)
    expect(status).toBe(200)
    expect(html).toContain('Jamie Bin Service')
    expect(html).toContain('Curb-to-house return')
  })

  it('shows the price formatted from integer cents', async () => {
    const { html } = await getPage(`/${slug}`)
    expect(html).toContain('$3.00')
    expect(html).toContain('/week')
  })

  it('states the billing cadence separately from the price', async () => {
    // PRD section 12: nobody should be surprised by a $12 charge they
    // thought was $3.
    const { html } = await getPage(`/${slug}`)
    expect(html).toContain('$12.00')
    expect(html).toContain('every 4 weeks')
  })

  it('shows the service day and window', async () => {
    const { html } = await getPage(`/${slug}`)
    expect(html.toLowerCase()).toContain('tuesday')
    expect(html).toContain('8:00 AM - 6:00 PM')
  })

  it('shows the coarse area label and the address check', async () => {
    const { html } = await getPage(`/${slug}`)
    expect(html).toContain('Oak Ridge')
    expect(html).toContain('Check my address')
  })
})

describe('nothing private reaches the HTML', () => {
  it('never contains the private service-area geometry', async () => {
    const { html } = await getPage(`/${slug}`)
    expect(html).not.toContain(PRIVATE_GEOMETRY_MARKER)
  })

  it('never contains the date of birth or provider identifiers', async () => {
    const { html } = await getPage(`/${slug}`)
    expect(html).not.toContain(dobForAge(15))
    expect(html).not.toContain(provider.domainId)
    expect(html).not.toContain(guardian.domainId)
    expect(html).not.toContain(PROVIDER_EMAIL)
    expect(html).not.toContain(GUARDIAN_EMAIL)
  })

  it('never contains the Stripe account id', async () => {
    const { html } = await getPage(`/${slug}`)
    expect(html).not.toContain(`acct_store_${stamp}`)
  })
})

describe('an unpublished page is simply not found', () => {
  it('404s an unknown slug', async () => {
    const { status } = await getPage('/no-such-business-anywhere')
    expect(status).toBe(404)
  })

  it('404s once a guardian revokes, rather than announcing a pause', async () => {
    const result = await revokeGuardianRelationship({
      db: admin,
      relationshipId,
      actorUserId: guardian.domainId,
      actorRole: 'guardian',
      reasonCode: 'guardian_request',
      now: new Date(),
    })
    expect(result.ok).toBe(true)

    // The business should now be paused_guardian, so the page disappears.
    const { data } = await admin
      .from('businesses')
      .select('state')
      .eq('id', businessId)
      .single()
    expect(data?.state).toBe('paused_guardian')

    const { status } = await getPage(`/${slug}`)
    expect(status).toBe(404)
  })
})
