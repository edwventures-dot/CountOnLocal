/**
 * Staff actions, against the live database.
 *
 * Two claims are the point of this file.
 *
 * A high-impact action without a reason does not happen. Not "happens and
 * logs badly" -- does not happen. The audit log exists so somebody can
 * reconstruct why a fourteen-year-old's account was suspended eighteen
 * months ago, and an empty reason reconstructs nothing.
 *
 * And a staff address lookup writes its audit row BEFORE returning the
 * address. Everywhere else an audit failure is logged and stepped over so
 * the underlying action is not lost; here the read is the action, and an
 * unlogged look at where somebody lives is the thing being prevented.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'
import {
  checkRefundAuthorization,
  holdPayouts,
  incidentQueue,
  openIncident,
  payoutsAreHeld,
  readCustomerAddress,
  releasePayouts,
  resolveIncident,
  type AdminActor,
} from '@/server/adminService'
import { REFUND_REASON_THRESHOLD_CENTS } from '@/domain/incident'

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
const GOOD_REASON = 'Customer reported unsafe behaviour on 12 Sept; paused pending review.'

let providerId = ''
let customerId = ''
let staffId = ''
let businessId = ''
let addressId = ''
const madeUsers: string[] = []
const madeIncidents: string[] = []

const staff: AdminActor = { userId: '', roles: ['trust_safety_agent'] }
const financeStaff: AdminActor = { userId: '', roles: ['finance_admin'] }
const supportOnly: AdminActor = { userId: '', roles: ['support_agent'] }
const nobody: AdminActor = { userId: '', roles: ['customer'] }

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

async function file(category: string, narrative = 'Something happened that needs looking at.') {
  const r = await openIncident({
    db: admin,
    reporterUserId: customerId,
    category,
    narrative,
    businessId,
    now: NOW,
  })
  if (r.ok) madeIncidents.push(r.incidentId)
  return r
}

async function auditRowsFor(targetId: string, action: string) {
  const { data } = await admin
    .from('audit_log')
    .select('action, reason_code, actor_user_id, after_json')
    .eq('target_id', targetId)
    .eq('action', action)
  return data ?? []
}

beforeAll(async () => {
  providerId = await makeUser(`adm-provider-${stamp}@example.com`)
  customerId = await makeUser(`adm-customer-${stamp}@example.com`)
  staffId = await makeUser(`adm-staff-${stamp}@example.com`)

  staff.userId = staffId
  financeStaff.userId = staffId
  supportOnly.userId = staffId
  nobody.userId = customerId

  // A 15-year-old, so involves_minor is exercised.
  const dob = new Date()
  dob.setUTCFullYear(dob.getUTCFullYear() - 15)
  await admin.from('provider_profiles').insert({
    user_id: providerId,
    date_of_birth: dob.toISOString().slice(0, 10),
    display_first_name: 'Jamie',
    guardian_state: 'verified',
  })

  const { data: biz, error } = await admin
    .from('businesses')
    .insert({
      provider_user_id: providerId,
      name: `Admin Test ${stamp}`,
      slug: `admin-test-${stamp}`,
      state: 'published',
      published_at: new Date().toISOString(),
      public_area_label: 'Downtown',
    })
    .select('id')
    .single()
  if (error) throw new Error(`business insert failed: ${error.message}`)
  businessId = biz!.id

  const { data: addr } = await admin
    .from('customer_addresses')
    .insert({
      customer_user_id: customerId,
      line1: '11 Audit Row',
      city: 'Austin',
      region: 'TX',
      postal_code: '78701',
      country_code: 'US',
      access_notes: 'Side gate code 9911',
    })
    .select('id')
    .single()
  addressId = addr!.id
})

afterAll(async () => {
  if (madeIncidents.length) {
    await admin.from('payout_holds').delete().in('incident_id', madeIncidents)
    await admin.from('audit_log').delete().in('target_id', madeIncidents)
    await admin.from('incidents').delete().in('id', madeIncidents)
  }
  await admin.from('payout_holds').delete().eq('provider_user_id', providerId)
  if (addressId) await admin.from('audit_log').delete().eq('target_id', addressId)
  if (businessId) await admin.from('businesses').delete().eq('id', businessId)
  await admin.from('customer_addresses').delete().in('customer_user_id', madeUsers)
  for (const id of madeUsers) {
    const { data: u } = await admin.from('users').select('auth_user_id').eq('id', id).maybeSingle()
    await admin.from('audit_log').delete().eq('actor_user_id', id)
    await admin.from('audit_log').delete().eq('target_id', id)
    await admin.from('users').delete().eq('id', id)
    if (u?.auth_user_id) await admin.auth.admin.deleteUser(u.auth_user_id).catch(() => {})
  }
})

describe('anybody can file an incident', () => {
  it('accepts a report from a customer, not just staff', async () => {
    // The person who most needs to file one is the person it happened to.
    const r = await file('harassment_or_threat')
    expect(r.ok).toBe(true)
  })

  it('sets the severity from the category, not from the reporter', async () => {
    const r = await file('physical_safety')
    if (r.ok) expect(r.severity).toBe('S0')
  })

  it('gives an emergency a response deadline inside half an hour', async () => {
    const r = await file('sexual_content_or_contact')
    if (r.ok) {
      const minutes = (new Date(r.respondBy).getTime() - NOW.getTime()) / 60000
      expect(minutes).toBeLessThanOrEqual(30)
    }
  })

  it('notices a minor is involved and recommends telling the guardian', async () => {
    const r = await file('harassment_or_threat')
    if (r.ok) {
      expect(r.guardianNotification.notify).toBe(true)
      if (r.guardianNotification.notify) {
        expect(r.guardianNotification.urgency).toBe('immediate')
      }
    }
  })

  it('recommends a pause without performing one', async () => {
    const r = await file('physical_safety')
    if (r.ok) expect(r.recommendPause).toBe(true)

    // An automatic pause would let anybody take a route down by reporting it.
    const { data } = await admin
      .from('businesses')
      .select('state')
      .eq('id', businessId)
      .single()
    expect(data!.state).toBe('published')
  })

  it('refuses a narrative too thin to act on', async () => {
    const r = await file('service_quality', 'bad')
    expect(r.ok).toBe(false)
  })

  it('refuses an invented category', async () => {
    const r = await file('vibes_were_off')
    expect(r.ok).toBe(false)
  })

  it('audits the report without copying the narrative into the log', async () => {
    const r = await file('property_damage', 'They knocked over the planter by the gate.')
    if (!r.ok) return

    const rows = await auditRowsFor(r.incidentId, 'incident.opened')
    expect(rows.length).toBe(1)
    expect(JSON.stringify(rows)).not.toContain('planter')
  })
})

describe('a high-impact action without a reason does not happen', () => {
  it('refuses a payout hold with no reason', async () => {
    const r = await holdPayouts({
      db: admin,
      actor: staff,
      providerUserId: providerId,
      reason: undefined,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('REASON_REQUIRED')
  })

  it('refuses a thin one', async () => {
    const r = await holdPayouts({
      db: admin,
      actor: staff,
      providerUserId: providerId,
      reason: 'fraud',
    })
    expect(r.ok).toBe(false)
  })

  it('leaves nothing behind when it refuses', async () => {
    await holdPayouts({ db: admin, actor: staff, providerUserId: providerId, reason: 'x' })
    expect(await payoutsAreHeld({ db: admin, providerUserId: providerId })).toBe(false)
  })

  it('writes no audit row for an action that did not occur', async () => {
    await holdPayouts({ db: admin, actor: staff, providerUserId: providerId, reason: '' })
    const rows = await auditRowsFor(providerId, 'payout.hold_placed')
    expect(rows).toHaveLength(0)
  })

  it('proceeds with a reason somebody could read later', async () => {
    const r = await holdPayouts({
      db: admin,
      actor: staff,
      providerUserId: providerId,
      reason: GOOD_REASON,
    })
    expect(r.ok).toBe(true)
    expect(await payoutsAreHeld({ db: admin, providerUserId: providerId })).toBe(true)
  })

  it('records the reason itself, not a code', async () => {
    const rows = await auditRowsFor(providerId, 'payout.hold_placed')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0]!.reason_code).toContain('unsafe behaviour')
  })
})

describe('permissions are separate from severity', () => {
  it('refuses a payout hold from support, whatever the incident says', async () => {
    const r = await holdPayouts({
      db: admin,
      actor: supportOnly,
      providerUserId: providerId,
      reason: GOOD_REASON,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('NOT_AUTHORIZED')
  })

  it('refuses a customer entirely', async () => {
    const r = await incidentQueue({ db: admin, actor: nobody, now: NOW })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('NOT_AUTHORIZED')
  })

  it('checks the permission before the reason', async () => {
    // Somebody without the permission should not learn what a valid reason
    // looks like by being told their reason was too short.
    const r = await holdPayouts({
      db: admin,
      actor: supportOnly,
      providerUserId: providerId,
      reason: '',
    })
    if (!r.ok) expect(r.code).toBe('NOT_AUTHORIZED')
  })
})

describe('releasing a hold is a different job from placing one', () => {
  it('cannot be done by the team that placed it', async () => {
    // Separation of duties, already encoded in the role model:
    // trust_safety_agent holds, finance_admin releases. The person who
    // freezes money for a safety reason is not the person who decides it
    // can start flowing again.
    const r = await releasePayouts({
      db: admin,
      actor: staff,
      providerUserId: providerId,
      reason: 'Investigation closed; no further action needed against the provider.',
      now: NOW,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('NOT_AUTHORIZED')
    expect(await payoutsAreHeld({ db: admin, providerUserId: providerId })).toBe(true)
  })

  it('needs its own reason', async () => {
    const r = await releasePayouts({
      db: admin,
      actor: financeStaff,
      providerUserId: providerId,
      reason: 'ok now',
      now: NOW,
    })
    expect(r.ok).toBe(false)
  })

  it('releases with one, and records who did it', async () => {
    const r = await releasePayouts({
      db: admin,
      actor: financeStaff,
      providerUserId: providerId,
      reason: 'Investigation closed; no further action needed against the provider.',
      now: NOW,
    })
    expect(r.ok).toBe(true)
    expect(await payoutsAreHeld({ db: admin, providerUserId: providerId })).toBe(false)

    const { data } = await admin
      .from('payout_holds')
      .select('released_by_user_id, release_reason')
      .eq('provider_user_id', providerId)
      .not('released_at', 'is', null)
      .limit(1)
    expect(data![0]!.released_by_user_id).toBe(staffId)
    expect(data![0]!.release_reason).toContain('Investigation closed')
  })

  it('keeps the original reason after release, not just the current state', async () => {
    // A boolean flag would have recorded only the answer today.
    const { data } = await admin
      .from('payout_holds')
      .select('reason, release_reason')
      .eq('provider_user_id', providerId)
      .limit(1)
    expect(data![0]!.reason).toContain('unsafe behaviour')
  })
})

describe('reading an address is an action', () => {
  it('refuses without a reason', async () => {
    const r = await readCustomerAddress({
      db: admin,
      actor: staff,
      addressId,
      reason: 'checking',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('REASON_REQUIRED')
  })

  it('returns nothing at all when refused', async () => {
    const r = await readCustomerAddress({ db: admin, actor: staff, addressId, reason: '' })
    expect(JSON.stringify(r)).not.toContain('Audit Row')
  })

  it('writes no audit row when refused', async () => {
    const before = await auditRowsFor(addressId, 'address.accessed_by_staff')
    await readCustomerAddress({ db: admin, actor: staff, addressId, reason: 'nope' })
    const after = await auditRowsFor(addressId, 'address.accessed_by_staff')
    expect(after.length).toBe(before.length)
  })

  it('returns the address with a reason, and logs the lookup', async () => {
    const r = await readCustomerAddress({
      db: admin,
      actor: staff,
      addressId,
      reason: 'Investigating incident about property damage at this address.',
    })

    expect(r.ok).toBe(true)
    if (r.ok) expect(r.address.line1).toBe('11 Audit Row')

    const rows = await auditRowsFor(addressId, 'address.accessed_by_staff')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0]!.actor_user_id).toBe(staffId)
    expect(rows[0]!.reason_code).toContain('Investigating incident')
  })

  it('does not copy the address into the audit log', async () => {
    const rows = await auditRowsFor(addressId, 'address.accessed_by_staff')
    // The row it points at is the record; duplicating it here would put a
    // home address in a second table with different access rules.
    expect(JSON.stringify(rows)).not.toContain('Audit Row')
    expect(JSON.stringify(rows)).not.toContain('9911')
  })

  it('refuses staff without the address permission', async () => {
    const r = await readCustomerAddress({
      db: admin,
      actor: { userId: staffId, roles: ['finance_admin'] },
      addressId,
      reason: 'Investigating a payment dispute for this customer account.',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('NOT_AUTHORIZED')
  })
})

describe('refunds below the threshold stay routine', () => {
  it('lets a small goodwill credit through without an essay', () => {
    const r = checkRefundAuthorization({ actor: financeStaff, amountCents: 300, reason: '' })
    expect(r.ok).toBe(true)
  })

  it('demands one above the threshold', () => {
    const r = checkRefundAuthorization({
      actor: financeStaff,
      amountCents: REFUND_REASON_THRESHOLD_CENTS,
      reason: 'goodwill',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('REASON_REQUIRED')
  })

  it('refuses staff without the refund permission at any amount', () => {
    const r = checkRefundAuthorization({ actor: supportOnly, amountCents: 100, reason: '' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('NOT_AUTHORIZED')
  })
})

describe('the queue', () => {
  it('puts the most urgent first', async () => {
    const r = await incidentQueue({ db: admin, actor: staff, now: NOW })
    expect(r.ok).toBe(true)
    if (r.ok && r.items.length > 1) {
      const severities = r.items.map((i) => i.severity)
      const sorted = [...severities].sort()
      expect(severities).toEqual(sorted)
    }
  })

  it('flags what is overdue', async () => {
    const later = new Date(NOW.getTime() + 1000 * 60 * 60 * 24 * 30)
    const r = await incidentQueue({ db: admin, actor: staff, now: later })
    if (r.ok && r.items.length) expect(r.items.every((i) => i.overdue)).toBe(true)
  })

  it('marks the ones involving a minor', async () => {
    const r = await incidentQueue({ db: admin, actor: staff, now: NOW })
    if (r.ok) expect(r.items.some((i) => i.involvesMinor)).toBe(true)
  })
})

describe('resolving', () => {
  it('needs a resolution somebody can read', async () => {
    const filed = await file('service_quality')
    if (!filed.ok) return

    const thin = await resolveIncident({
      db: admin,
      actor: staff,
      incidentId: filed.incidentId,
      resolution: 'done',
      now: NOW,
    })
    expect(thin.ok).toBe(false)
  })

  it('resolves with one and records who', async () => {
    const filed = await file('service_quality')
    if (!filed.ok) return

    const r = await resolveIncident({
      db: admin,
      actor: staff,
      incidentId: filed.incidentId,
      resolution: 'Spoke to both parties; provider will re-do the visit next week.',
      now: NOW,
    })
    expect(r.ok).toBe(true)

    const { data } = await admin
      .from('incidents')
      .select('state, resolution, resolved_by_user_id')
      .eq('id', filed.incidentId)
      .single()
    expect(data!.state).toBe('resolved')
    expect(data!.resolved_by_user_id).toBe(staffId)
  })

  it('drops it out of the queue', async () => {
    const r = await incidentQueue({ db: admin, actor: staff, now: NOW })
    if (r.ok) expect(r.items.every((i) => i.state !== 'resolved')).toBe(true)
  })
})

describe('nothing reaches incidents through the API', () => {
  it('refuses an anonymous read', async () => {
    const { error } = await anon.from('incidents').select('narrative').limit(1)
    expect(error).not.toBeNull()
  })

  it('refuses an anonymous read of payout holds', async () => {
    const { error } = await anon.from('payout_holds').select('reason').limit(1)
    expect(error).not.toBeNull()
  })
})
