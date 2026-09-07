/**
 * A person between a signed consent and a minor's first customer.
 *
 * The claim being tested is not "a row was written". It is that a
 * 13-to-17-year-old whose guardian has signed everything still cannot
 * accept a paying customer until somebody with the permission says so --
 * and that when they do, the decision is recorded with who made it and
 * whether they were in the room.
 *
 * `verified` is the gate that has always mattered: providerCanAccept and
 * the payout path both key on it. So the test asserts the state, because
 * that is the thing the rest of the system reads.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'
import { recordConsent } from '@/server/consentService'
import { reviewGuardianRelationship, listPendingReviews } from '@/server/guardianReview'
import { CONSENT_DOCUMENTS } from '@/domain/consent'

const url = process.env['NEXT_PUBLIC_SUPABASE_URL']!
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY']!
const admin = createClient<Database>(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const stamp = Date.now()

let guardianId = ''
let staffId = ''

const GUARDIAN_ITEMS = CONSENT_DOCUMENTS.guardian_consent.items.map((i) => i.key)

async function makeUser(email: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: `Test-${stamp}-Aa1!`,
    email_confirm: true,
  })
  if (error || !data?.user) throw new Error(`createUser failed: ${error?.message}`)
  const { data: du } = await admin
    .from('users')
    .select('id')
    .eq('auth_user_id', data.user.id)
    .single()
  return du!.id
}

/**
 * A brand new minor for each test, rather than resetting one.
 *
 * guardian_reviews references the relationship with on delete restrict --
 * the same choice account_actions makes about users, because a record of a
 * decision about somebody should not vanish when a row upstream is tidied.
 * The retention system de-identifies those; it does not delete them.
 *
 * So a test that produces a review cannot then clear it, and a shared minor
 * would collide on ux_guardian_active_per_provider the moment the second
 * test ran. A fresh provider each time sidesteps that without weakening the
 * constraint the production system relies on.
 */
const minors: string[] = []

async function freshMinor(): Promise<{ minorId: string; relationshipId: string }> {
  const id = await makeUser(`review-minor-${stamp}-${minors.length}@example.com`)
  minors.push(id)

  await admin.from('provider_profiles').insert({
    user_id: id,
    date_of_birth: '2011-05-04',
    display_first_name: 'Sam',
    guardian_state: 'guardian_started',
  })

  const { data, error } = await admin
    .from('guardian_relationships')
    .insert({
      provider_user_id: id,
      guardian_user_id: guardianId,
      state: 'guardian_started',
      invitation_email: `guardian-${stamp}@example.com`,
      invitation_expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
    })
    .select('id')
    .single()
  if (error) throw new Error(`relationship insert failed: ${error.message}`)

  return { minorId: id, relationshipId: data!.id }
}

async function stateOf(id: string): Promise<string> {
  const { data } = await admin
    .from('provider_profiles')
    .select('guardian_state')
    .eq('user_id', id)
    .single()
  return data!.guardian_state
}

async function sign(subjectUserId: string) {
  return recordConsent({
    db: admin,
    kind: 'guardian_consent',
    signerUserId: guardianId,
    subjectUserId,
    acknowledgedItems: GUARDIAN_ITEMS,
    typedName: 'Alex Guardian',
  })
}

beforeAll(async () => {
  guardianId = await makeUser(`review-guardian-${stamp}@example.com`)
  staffId = await makeUser(`review-staff-${stamp}@example.com`)

  await admin.from('guardian_profiles').insert({ user_id: guardianId })

  await admin
    .from('platform_settings')
    .update({ value: 'on' })
    .eq('key', 'guardian_manual_review')
})

afterAll(async () => {
  // Best effort. A minor who was actually reviewed cannot be deleted --
  // guardian_reviews restricts it, deliberately -- so those rows stay, the
  // same way a real account that has been decided about is de-identified
  // rather than removed.
  await admin
    .from('platform_settings')
    .update({ value: 'on' })
    .eq('key', 'guardian_manual_review')

  for (const id of [...minors, guardianId, staffId].filter(Boolean)) {
    const { data: u } = await admin.from('users').select('auth_user_id').eq('id', id).maybeSingle()
    await admin.from('audit_log').delete().eq('actor_user_id', id)
    await admin.from('consent_records').delete().eq('subject_user_id', id)
    await admin.from('guardian_relationships').delete().eq('provider_user_id', id)
    await admin.from('provider_profiles').delete().eq('user_id', id)
    await admin.from('guardian_profiles').delete().eq('user_id', id)
    const { error } = await admin.from('users').delete().eq('id', id)
    if (!error && u?.auth_user_id) await admin.auth.admin.deleteUser(u.auth_user_id).catch(() => {})
  }
})

describe('a signed consent is no longer the last step', () => {
  it('stops at manual_review rather than going live', async () => {
    const { minorId } = await freshMinor()
    const signed = await sign(minorId)
    expect(signed.ok).toBe(true)

    // The gate everything else reads. Not verified: a person has not looked.
    expect(await stateOf(minorId)).toBe('manual_review')
  })

  it('puts them on the list of families to meet', async () => {
    const { minorId, relationshipId } = await freshMinor()
    await sign(minorId)
    const pending = await listPendingReviews(admin)
    expect(pending.some((p) => p.relationshipId === relationshipId)).toBe(true)
  })

  it('shows a first name and nothing more', async () => {
    const { minorId, relationshipId } = await freshMinor()
    await sign(minorId)
    const row = (await listPendingReviews(admin)).find((p) => p.relationshipId === relationshipId)!
    expect(row.providerFirstName).toBe('Sam')
    // Rule 1 does not stop applying because the reader is the owner.
    expect(Object.keys(row)).not.toContain('dateOfBirth')
    expect(JSON.stringify(row)).not.toContain('2011')
  })
})

describe('who may decide', () => {
  it('refuses somebody with no staff permission', async () => {
    const { minorId, relationshipId } = await freshMinor()
    await sign(minorId)
    const result = await reviewGuardianRelationship({
      db: admin,
      relationshipId,
      reviewerUserId: staffId,
      reviewerRoles: ['provider', 'customer'],
      approve: true,
      reason: 'seems fine',
      metInPerson: true,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('NOT_AUTHORIZED')
    expect(await stateOf(minorId)).toBe('manual_review')
  })

  it('refuses the guardian approving their own arrangement', async () => {
    // They already gave their answer. This is the separate question of
    // whether somebody else thinks it is sound.
    const { minorId, relationshipId } = await freshMinor()
    await sign(minorId)
    const result = await reviewGuardianRelationship({
      db: admin,
      relationshipId,
      reviewerUserId: guardianId,
      reviewerRoles: ['guardian'],
      approve: true,
      reason: 'I consent to my own child',
      metInPerson: true,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('NOT_AUTHORIZED')
    expect(await stateOf(minorId)).toBe('manual_review')
  })

  it('refuses an approval with no reasoning', async () => {
    const { minorId, relationshipId } = await freshMinor()
    await sign(minorId)
    const result = await reviewGuardianRelationship({
      db: admin,
      relationshipId,
      reviewerUserId: staffId,
      reviewerRoles: ['trust_safety_agent'],
      approve: true,
      reason: '  ',
      metInPerson: true,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('REASON_REQUIRED')
    expect(await stateOf(minorId)).toBe('manual_review')
  })
})

describe('the decision, once somebody makes it', () => {
  it('lets them start, and records who said so', async () => {
    const { minorId, relationshipId } = await freshMinor()
    await sign(minorId)
    const result = await reviewGuardianRelationship({
      db: admin,
      relationshipId,
      reviewerUserId: staffId,
      reviewerRoles: ['trust_safety_agent'],
      approve: true,
      reason: 'Met Sam and their mum at the house. Sam wants to do it.',
      metInPerson: true,
      present: 'Sam, mum',
    })

    expect(result.ok).toBe(true)
    expect(await stateOf(minorId)).toBe('verified')

    const { data: review } = await admin
      .from('guardian_reviews')
      .select('decision, reason, met_in_person, present, reviewed_by_user_id')
      .eq('relationship_id', relationshipId)
      .single()

    expect(review?.decision).toBe('approved')
    expect(review?.met_in_person).toBe(true)
    expect(review?.present).toBe('Sam, mum')
    expect(review?.reviewed_by_user_id).toBe(staffId)
  })

  it('records a remote decision as remote', async () => {
    // The day somebody approves one over the phone is the day it should be
    // legible that they did.
    const { minorId, relationshipId } = await freshMinor()
    await sign(minorId)
    await reviewGuardianRelationship({
      db: admin,
      relationshipId,
      reviewerUserId: staffId,
      reviewerRoles: ['trust_safety_agent'],
      approve: true,
      reason: 'Spoke to the family by phone; meeting next week.',
      metInPerson: false,
    })
    const { data } = await admin
      .from('guardian_reviews')
      .select('met_in_person')
      .eq('relationship_id', relationshipId)
      .single()
    expect(data?.met_in_person).toBe(false)
  })

  it('a denial revokes rather than leaving them waiting', async () => {
    const { minorId, relationshipId } = await freshMinor()
    await sign(minorId)
    const result = await reviewGuardianRelationship({
      db: admin,
      relationshipId,
      reviewerUserId: staffId,
      reviewerRoles: ['trust_safety_agent'],
      approve: false,
      reason: 'The child did not seem to want this.',
      metInPerson: true,
    })
    expect(result.ok).toBe(true)
    expect(await stateOf(minorId)).toBe('revoked')
  })

  it('cannot be decided twice', async () => {
    const { minorId, relationshipId } = await freshMinor()
    await sign(minorId)
    const args = {
      db: admin,
      relationshipId,
      reviewerUserId: staffId,
      reviewerRoles: ['trust_safety_agent'] as const,
      approve: true,
      reason: 'Met the family.',
      metInPerson: true,
    }
    expect((await reviewGuardianRelationship({ ...args })).ok).toBe(true)
    const second = await reviewGuardianRelationship({ ...args })
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.code).toBe('ILLEGAL_TRANSITION')
  })

  it('writes an audit row naming the staff role, not the actor’s first role', async () => {
    const { minorId, relationshipId } = await freshMinor()
    await sign(minorId)
    await reviewGuardianRelationship({
      db: admin,
      relationshipId,
      reviewerUserId: staffId,
      reviewerRoles: ['customer', 'trust_safety_agent'],
      approve: true,
      reason: 'Met the family at home.',
      metInPerson: true,
    })
    const { data } = await admin
      .from('audit_log')
      .select('action, actor_role')
      .eq('target_id', relationshipId)
      .eq('action', 'guardian.review_approved')
      .maybeSingle()
    expect(data?.actor_role).toBe('trust_safety_agent')
  })
})

describe('with the review policy switched off', () => {
  it('behaves as it always did and verifies immediately', async () => {
    await admin
      .from('platform_settings')
      .update({ value: 'off' })
      .eq('key', 'guardian_manual_review')
    try {
      const { minorId } = await freshMinor()
      await sign(minorId)
      expect(await stateOf(minorId)).toBe('verified')
    } finally {
      await admin
        .from('platform_settings')
        .update({ value: 'on' })
        .eq('key', 'guardian_manual_review')
    }
  })
})
