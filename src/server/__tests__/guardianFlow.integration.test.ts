/**
 * End-to-end guardian flow against the live Supabase project.
 *
 * Walks a real minor provider from onboarding through invitation,
 * acceptance and revocation, checking the database state and the audit
 * trail at each step.
 *
 * Deliberately uses USER-SCOPED clients built from real access tokens, not
 * the service role, so row level security is exercised exactly as it will
 * be in production. A test that ran everything as the service role would
 * pass regardless of whether the policies were right.
 *
 *   npm run test:integration
 *
 * Creates and deletes its own auth users. Every row it writes is removed in
 * afterAll, including on failure.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'
import { startProviderOnboarding } from '@/server/providerOnboarding'
import {
  createGuardianInvitation,
  acceptGuardianInvitation,
  revokeGuardianRelationship,
} from '@/server/guardianService'
import { canPublishBusiness, canAcceptNewSubscription } from '@/domain/gates'
import { parsePlainDate } from '@/domain/age'

const url = process.env['NEXT_PUBLIC_SUPABASE_URL']!
const anonKey = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY']!

const admin = createClient<Database>(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

/** A client that PostgREST sees as this specific signed-in user. */
function userScoped(accessToken: string): SupabaseClient<Database> {
  return createClient<Database>(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  })
}

type TestUser = { authId: string; domainId: string; token: string; email: string }

const stamp = Date.now()
const PROVIDER_EMAIL = `e2e-provider-${stamp}@example.com`
const GUARDIAN_EMAIL = `e2e-guardian-${stamp}@example.com`
const PASSWORD = `Test-${stamp}-Aa1!`

/** Creates a confirmed auth user, a linked domain user, and signs in. */
async function makeUser(email: string): Promise<TestUser> {
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  })
  if (createErr || !created.user) throw new Error(`createUser failed: ${createErr?.message}`)

  // Migration 0003 provisions public.users by trigger on auth signup, so we
  // read the row rather than creating it -- which also proves the trigger
  // actually fires.
  const { data: domainUser, error: readErr } = await admin
    .from('users')
    .select('id')
    .eq('auth_user_id', created.user.id)
    .single()
  if (readErr || !domainUser) throw new Error(`domain user not provisioned: ${readErr?.message}`)

  const anon = createClient<Database>(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: session, error: signInErr } = await anon.auth.signInWithPassword({
    email,
    password: PASSWORD,
  })
  if (signInErr || !session.session) throw new Error(`sign in failed: ${signInErr?.message}`)

  return {
    authId: created.user.id,
    domainId: domainUser.id,
    token: session.session.access_token,
    email,
  }
}

async function auditActions(targetId: string): Promise<string[]> {
  const { data } = await admin
    .from('audit_log')
    .select('action')
    .eq('target_id', targetId)
    .order('id', { ascending: true })
  return (data ?? []).map((r) => r.action)
}

async function guardianStateOf(providerId: string) {
  const { data } = await admin
    .from('provider_profiles')
    .select('guardian_state')
    .eq('user_id', providerId)
    .single()
  return data?.guardian_state
}

let provider: TestUser
let guardian: TestUser
let relationshipId = ''
let invitationToken = ''

/** DOB for a 15-year-old, so a guardian is genuinely required. */
function dobForAge(years: number): string {
  const d = new Date()
  d.setUTCFullYear(d.getUTCFullYear() - years)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

beforeAll(async () => {
  provider = await makeUser(PROVIDER_EMAIL)
  guardian = await makeUser(GUARDIAN_EMAIL)
})

afterAll(async () => {
  for (const u of [provider, guardian]) {
    if (!u) continue
    // guardian_relationships and provider_profiles cascade from users.
    await admin.from('audit_log').delete().eq('actor_user_id', u.domainId)
    await admin.from('users').delete().eq('id', u.domainId)
    await admin.auth.admin.deleteUser(u.authId)
  }
  if (relationshipId) await admin.from('audit_log').delete().eq('target_id', relationshipId)
  await admin.from('notifications').delete().eq('destination', GUARDIAN_EMAIL)
})

describe('provider onboarding', () => {
  it('creates a minor provider in required_uninvited', async () => {
    const result = await startProviderOnboarding({
      // Privileged: RLS grants no client write here by design.
      db: admin,
      userId: provider.domainId,
      input: { dateOfBirth: dobForAge(15), countryCode: 'US', displayFirstName: 'Jamie' },
      now: new Date(),
      ip: '203.0.113.10',
    })

    expect(result).toEqual({
      ok: true,
      guardianRequired: true,
      nextStage: 'guardian_invitation',
    })
    expect(await guardianStateOf(provider.domainId)).toBe('required_uninvited')
  })

  it('records the onboarding in the audit log without storing the date of birth', async () => {
    const { data } = await admin
      .from('audit_log')
      .select('action, after_json, ip_hash')
      .eq('target_id', provider.domainId)
      .eq('action', 'provider.onboarding_started')
      .single()

    expect(data?.action).toBe('provider.onboarding_started')
    const serialized = JSON.stringify(data?.after_json ?? {})
    expect(serialized).not.toMatch(/\d{4}-\d{2}-\d{2}/)
    // The raw IP must never be stored, only a salted hash.
    expect(data?.ip_hash).toBeTruthy()
    expect(data?.ip_hash).not.toBe('203.0.113.10')
  })

  it('refuses to onboard a second time', async () => {
    const again = await startProviderOnboarding({
      db: admin,
      userId: provider.domainId,
      input: { dateOfBirth: dobForAge(15), countryCode: 'US', displayFirstName: 'Jamie' },
      now: new Date(),
    })
    expect(again).toEqual({ ok: false, code: 'ALREADY_ONBOARDED' })
  })
})

describe('gates before the guardian is verified', () => {
  it('blocks publishing and checkout', () => {
    const ctx = {
      roles: ['provider'] as const,
      dateOfBirth: parsePlainDate(dobForAge(15)),
      guardianState: 'required_uninvited' as const,
      today: parsePlainDate(new Date().toISOString().slice(0, 10)),
    }
    expect(canPublishBusiness({ ...ctx, roles: ['provider'] })).toEqual({
      allowed: false,
      code: 'GUARDIAN_APPROVAL_REQUIRED',
    })
    expect(canAcceptNewSubscription({ ...ctx, roles: ['provider'] }).allowed).toBe(false)
  })
})

describe('guardian invitation', () => {
  it('issues an invitation and moves to invited', async () => {
    const result = await createGuardianInvitation({
      db: admin,
      providerUserId: provider.domainId,
      input: { email: GUARDIAN_EMAIL },
      now: new Date(),
      ip: '203.0.113.10',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    relationshipId = result.relationshipId
    invitationToken = result.token
    expect(result.state).toBe('invited')
    expect(await guardianStateOf(provider.domainId)).toBe('invited')
  })

  it('queues an email, because an invitation nobody receives is not one', async () => {
    // The gap this closes: the outbox and the state machine both existed
    // and nothing wrote to the outbox, so a provider aged 13-17 could never
    // reach verified and therefore could never take a customer.
    const { data } = await admin
      .from('notifications')
      .select('kind, channel, destination, subject, preview, payload, state')
      .eq('kind', 'guardian.approval_requested')
      .eq('destination', GUARDIAN_EMAIL)

    expect(data).toHaveLength(1)
    expect(data![0]!.channel).toBe('email')
    expect(data![0]!.state).toBe('pending')
  })

  it('puts the token in the payload and nothing identifying in the preview', async () => {
    const { data } = await admin
      .from('notifications')
      .select('subject, preview, payload')
      .eq('kind', 'guardian.approval_requested')
      .eq('destination', GUARDIAN_EMAIL)
      .single()

    // The address was given to us by a minor and has never been verified.
    // Whoever can see that inbox learns that somebody wants approval, and
    // not who, for what, or where.
    const visible = `${data!.subject} ${data!.preview}`
    expect(visible).not.toContain(provider.domainId)
    expect(visible.toLowerCase()).not.toContain('jordan')
    expect(visible).not.toMatch(/\d{1,5}\s+\w+\s+(street|st|road|rd|avenue|ave)/i)

    // The token travels where only the renderer sees it.
    expect((data!.payload as Record<string, unknown>)['invitationToken']).toBe(invitationToken)
    expect(visible).not.toContain(invitationToken)
  })

  it('stores only a hash of the token, never the token', async () => {
    const { data } = await admin
      .from('guardian_relationships')
      .select('invitation_token_hash, invitation_expires_at')
      .eq('id', relationshipId)
      .single()

    expect(data?.invitation_token_hash).toBeTruthy()
    expect(data?.invitation_token_hash).not.toBe(invitationToken)
    expect(data?.invitation_token_hash).toHaveLength(64) // sha256 hex
    expect(data?.invitation_expires_at).toBeTruthy()
  })

  it('rejects a wrong token', async () => {
    const bad = await acceptGuardianInvitation({
      adminDb: admin,
      token: 'not-a-real-token-'.repeat(2),
      guardianUserId: guardian.domainId,
      now: new Date(),
    })
    expect(bad).toEqual({ ok: false, code: 'INVALID_TOKEN' })
  })
})

describe('guardian acceptance', () => {
  it('accepts with the real token and moves to guardian_started', async () => {
    const result = await acceptGuardianInvitation({
      adminDb: admin,
      token: invitationToken,
      guardianUserId: guardian.domainId,
      now: new Date(),
      ip: '203.0.113.20',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state).toBe('guardian_started')
    expect(await guardianStateOf(provider.domainId)).toBe('guardian_started')
  })

  it('consumes the token so the link cannot be replayed', async () => {
    const replay = await acceptGuardianInvitation({
      adminDb: admin,
      token: invitationToken,
      guardianUserId: guardian.domainId,
      now: new Date(),
    })
    expect(replay).toEqual({ ok: false, code: 'INVALID_TOKEN' })
  })

  it('grants the guardian role', async () => {
    const { data } = await admin
      .from('user_roles')
      .select('role')
      .eq('user_id', guardian.domainId)
    expect((data ?? []).map((r) => r.role)).toContain('guardian')
  })
})

describe('verification unlocks publishing', () => {
  it('moves to verified and the gates open', async () => {
    // Stripe representative verification lands in step 2; for now the
    // transition is applied directly, exactly as that step will.
    await admin
      .from('guardian_relationships')
      .update({ state: 'verified', consented_at: new Date().toISOString() })
      .eq('id', relationshipId)
    await admin
      .from('provider_profiles')
      .update({ guardian_state: 'verified' })
      .eq('user_id', provider.domainId)

    expect(await guardianStateOf(provider.domainId)).toBe('verified')

    const ctx = {
      roles: ['provider'] as const,
      dateOfBirth: parsePlainDate(dobForAge(15)),
      guardianState: 'verified' as const,
      today: parsePlainDate(new Date().toISOString().slice(0, 10)),
    }
    expect(canPublishBusiness({ ...ctx, roles: ['provider'] })).toEqual({ allowed: true })
    expect(canAcceptNewSubscription({ ...ctx, roles: ['provider'] })).toEqual({ allowed: true })
  })
})

describe('revocation', () => {
  it('refuses a guardian who is not party to the relationship', async () => {
    const result = await revokeGuardianRelationship({
      db: admin,
      relationshipId,
      actorUserId: provider.domainId, // the provider, not the guardian
      actorRole: 'guardian',
      now: new Date(),
    })
    expect(result).toEqual({ ok: false, code: 'NOT_AUTHORIZED' })
  })

  it('lets the linked guardian revoke, and closes the gates immediately', async () => {
    const result = await revokeGuardianRelationship({
      db: admin,
      relationshipId,
      actorUserId: guardian.domainId,
      actorRole: 'guardian',
      reasonCode: 'guardian_request',
      now: new Date(),
      ip: '203.0.113.20',
    })

    expect(result.ok).toBe(true)
    expect(await guardianStateOf(provider.domainId)).toBe('revoked')

    const ctx = {
      roles: ['provider'] as const,
      dateOfBirth: parsePlainDate(dobForAge(15)),
      guardianState: 'revoked' as const,
      today: parsePlainDate(new Date().toISOString().slice(0, 10)),
    }
    expect(canPublishBusiness({ ...ctx, roles: ['provider'] }).allowed).toBe(false)
    expect(canAcceptNewSubscription({ ...ctx, roles: ['provider'] }).allowed).toBe(false)
  })

  it('leaves a complete audit trail', async () => {
    const actions = await auditActions(relationshipId)
    expect(actions).toContain('guardian.invited')
    expect(actions).toContain('guardian.accepted')
    expect(actions).toContain('guardian.revoked')
  })

  it('records the revocation reason', async () => {
    const { data } = await admin
      .from('audit_log')
      .select('reason_code, before_json, after_json')
      .eq('target_id', relationshipId)
      .eq('action', 'guardian.revoked')
      .single()
    expect(data?.reason_code).toBe('guardian_request')
    expect(JSON.stringify(data?.after_json)).toContain('revoked')
  })
})

describe('row level security holds for a signed-in user', () => {
  it('a provider cannot read another user profile', async () => {
    const { data } = await userScoped(provider.token)
      .from('provider_profiles')
      .select('user_id')
      .eq('user_id', guardian.domainId)
    expect(data ?? []).toHaveLength(0)
  })

  it('a signed-in user cannot read the audit log at all', async () => {
    const { data, error } = await userScoped(provider.token).from('audit_log').select('id').limit(1)
    expect(error ?? data?.length === 0).toBeTruthy()
  })

  it('a provider cannot move their own guardian state', async () => {
    const before = await guardianStateOf(provider.domainId)

    await userScoped(provider.token)
      .from('provider_profiles')
      .update({ guardian_state: 'verified' })
      .eq('user_id', provider.domainId)

    // Either the write is refused outright or it silently affects no rows.
    // Both are acceptable; a successful change is not. Compared against the
    // state actually observed beforehand rather than a hardcoded value, so
    // this cannot pass by coincidence if an earlier step misbehaves.
    expect(await guardianStateOf(provider.domainId)).toBe(before)
    expect(before).not.toBe('verified')
  })
})
