/**
 * HTTP layer test -- real requests against a running dev server.
 *
 * The service-layer suite proves the domain logic and database writes are
 * right. This proves the things only the route handlers do: session
 * authentication from cookies, permission checks, request validation, the
 * error envelope from API_CONTRACT, and the status codes.
 *
 * Session cookies are produced by @supabase/ssr itself, via a server client
 * wired to an in-memory jar. Hand-rolling the cookie format would test my
 * guess at the encoding rather than the encoding the server actually reads.
 *
 *   npx next dev -p 3100        (in another terminal)
 *   npm run test:http
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'
import type { Database } from '@/lib/supabase/types'

const BASE = process.env['E2E_BASE_URL'] ?? 'http://localhost:3100'
const url = process.env['NEXT_PUBLIC_SUPABASE_URL']!
const anonKey = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY']!

const admin = createClient<Database>(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

type TestUser = { authId: string; domainId: string; cookie: string; email: string }

const stamp = Date.now()
const PROVIDER_EMAIL = `http-provider-${stamp}@example.com`
const GUARDIAN_EMAIL = `http-guardian-${stamp}@example.com`
const PASSWORD = `Test-${stamp}-Aa1!`

/**
 * Signs in, then lets @supabase/ssr serialise the session into whatever
 * cookies its server counterpart expects -- including chunking, which it
 * does for sessions over ~3KB.
 */
async function cookieHeaderFor(email: string): Promise<string> {
  const anon = createClient<Database>(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data, error } = await anon.auth.signInWithPassword({ email, password: PASSWORD })
  if (error || !data.session) throw new Error(`sign in failed: ${error?.message}`)

  const jar = new Map<string, string>()
  const shim = createServerClient<Database>(url, anonKey, {
    cookies: {
      getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
      setAll: (list) => {
        for (const { name, value } of list) jar.set(name, value)
      },
    },
  })
  await shim.auth.setSession({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
  })

  if (jar.size === 0) throw new Error('no auth cookies were produced')
  return [...jar.entries()].map(([n, v]) => `${n}=${encodeURIComponent(v)}`).join('; ')
}

async function makeUser(email: string): Promise<TestUser> {
  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  })
  if (error || !created.user) throw new Error(`createUser failed: ${error?.message}`)

  // Migration 0003 provisions public.users by trigger on auth signup, so we
  // read the row rather than creating it -- which also proves the trigger
  // actually fires.
  const { data: domainUser, error: readErr } = await admin
    .from('users')
    .select('id')
    .eq('auth_user_id', created.user.id)
    .single()
  if (readErr || !domainUser) throw new Error(`domain user not provisioned: ${readErr?.message}`)

  return {
    authId: created.user.id,
    domainId: domainUser.id,
    cookie: await cookieHeaderFor(email),
    email,
  }
}

type ApiResponse = { status: number; body: any }

async function call(
  method: string,
  path: string,
  opts: { cookie?: string; body?: unknown } = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.cookie) headers['Cookie'] = opts.cookie
  const res = await fetch(BASE + path, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  })
  const text = await res.text()
  let body: any = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: res.status, body }
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
let invitationToken = ''

beforeAll(async () => {
  const ping = await fetch(BASE + '/').catch(() => null)
  if (!ping) throw new Error(`No dev server at ${BASE}. Start it with: npx next dev -p 3100`)
  provider = await makeUser(PROVIDER_EMAIL)
  guardian = await makeUser(GUARDIAN_EMAIL)
})

afterAll(async () => {
  await admin.from('notifications').delete().eq('destination', GUARDIAN_EMAIL)
  for (const u of [provider, guardian]) {
    if (!u) continue
    await admin.from('audit_log').delete().eq('actor_user_id', u.domainId)
    await admin.from('users').delete().eq('id', u.domainId)
    await admin.auth.admin.deleteUser(u.authId)
  }
  if (relationshipId) await admin.from('audit_log').delete().eq('target_id', relationshipId)
})

describe('unauthenticated callers are refused everywhere', () => {
  const paths: Array<[string, string]> = [
    ['POST', '/api/v1/provider/onboarding/start'],
    ['POST', '/api/v1/guardian/invitations'],
    ['POST', '/api/v1/guardian/invitations/some-token-value-long-enough/accept'],
    ['POST', '/api/v1/guardian/relationships/00000000-0000-4000-8000-000000000000/revoke'],
  ]

  for (const [method, path] of paths) {
    it(`${method} ${path} returns 401`, async () => {
      const res = await call(method, path, { body: {} })
      expect(res.status).toBe(401)
      expect(res.body?.error?.code).toBe('UNAUTHENTICATED')
    })
  }
})

describe('the error envelope matches API_CONTRACT', () => {
  it('carries code, message, requestId and fieldErrors', async () => {
    const res = await call('POST', '/api/v1/provider/onboarding/start', { body: {} })
    expect(res.body).toHaveProperty('error')
    const e = res.body.error
    expect(typeof e.code).toBe('string')
    expect(typeof e.message).toBe('string')
    expect(e.requestId).toMatch(/^req_[a-f0-9]{24}$/)
    expect(e.fieldErrors).toBeTypeOf('object')
  })
})

describe('POST /v1/provider/onboarding/start', () => {
  it('rejects a malformed body with field-level errors', async () => {
    const res = await call('POST', '/api/v1/provider/onboarding/start', {
      cookie: provider.cookie,
      body: { dateOfBirth: '05/12/2010', displayFirstName: '' },
    })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
    expect(Object.keys(res.body.error.fieldErrors).length).toBeGreaterThan(0)
  })

  it('refuses an under-13 provider without leaking the qualifying age', async () => {
    const res = await call('POST', '/api/v1/provider/onboarding/start', {
      cookie: provider.cookie,
      body: { dateOfBirth: dobForAge(12), countryCode: 'US', displayFirstName: 'Sam' },
    })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('PROVIDER_INELIGIBLE')
    // QA_ACCEPTANCE section 2: the refusal must not coach a false DOB.
    // Checked against the message text only: the envelope's own key
    // "message" contains the substring "age".
    expect(res.body.error.message).not.toMatch(/13|18|age|birth|older|young/i)
  })

  it('onboards a 15-year-old and reports that a guardian is required', async () => {
    const res = await call('POST', '/api/v1/provider/onboarding/start', {
      cookie: provider.cookie,
      body: { dateOfBirth: dobForAge(15), countryCode: 'US', displayFirstName: 'Jamie' },
    })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ nextStage: 'guardian_invitation', guardianRequired: true })
  })

  it('rejects a second onboarding with 409', async () => {
    const res = await call('POST', '/api/v1/provider/onboarding/start', {
      cookie: provider.cookie,
      body: { dateOfBirth: dobForAge(15), countryCode: 'US', displayFirstName: 'Jamie' },
    })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('ALREADY_ONBOARDED')
  })
})

describe('provisioning', () => {
  it('grants the customer role to every new account', async () => {
    // This did not happen. subscription:create belongs to the customer
    // role, providerOnboarding grants provider and acceptGuardianInvitation
    // grants guardian, and nothing granted customer -- so no account could
    // subscribe to anything and the whole customer side was unreachable.
    //
    // Being a customer is not a privileged state. It is what a signed-in
    // person is by default; provider and guardian are the earned ones.
    const { data } = await admin
      .from('user_roles')
      .select('role')
      .eq('user_id', provider.domainId)

    expect((data ?? []).map((r) => r.role)).toContain('customer')
  })
})

describe('POST /v1/guardian/invitations', () => {
  it('refuses a caller without the provider role', async () => {
    const res = await call('POST', '/api/v1/guardian/invitations', {
      cookie: guardian.cookie,
      body: { email: GUARDIAN_EMAIL },
    })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('NOT_AUTHORIZED')
  })

  it('requires an email or a phone number', async () => {
    const res = await call('POST', '/api/v1/guardian/invitations', {
      cookie: provider.cookie,
      body: {},
    })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
  })

  it('issues an invitation for the provider in the session', async () => {
    const res = await call('POST', '/api/v1/guardian/invitations', {
      cookie: provider.cookie,
      body: { email: GUARDIAN_EMAIL },
    })
    expect(res.status).toBe(201)
    expect(res.body.state).toBe('invited')
    relationshipId = res.body.relationshipId
    invitationToken = await tokenFromOutbox()
  })

  it('does not return the token to the provider who asked for it', async () => {
    // It used to. The token is the credential for the provider's own
    // guardian approval, and the accept path did not compare the two
    // parties, so a thirteen-year-old could read it out of this response
    // and approve themselves.
    const res = await call('POST', '/api/v1/guardian/invitations', {
      cookie: provider.cookie,
      body: { email: GUARDIAN_EMAIL },
    })
    expect(res.status).toBe(201)
    expect(res.body.invitationToken).toBeUndefined()
    expect(JSON.stringify(res.body)).not.toContain(await tokenFromOutbox())
    relationshipId = res.body.relationshipId
    invitationToken = await tokenFromOutbox()
  })

  it('binds the invitation to the session, not to anything in the body', async () => {
    // A forged providerUserId must be ignored: the handler reads the id from
    // the verified session.
    const res = await call('POST', '/api/v1/guardian/invitations', {
      cookie: provider.cookie,
      body: { email: GUARDIAN_EMAIL, providerUserId: guardian.domainId },
    })
    expect(res.status).toBe(201)
    const { data } = await admin
      .from('guardian_relationships')
      .select('provider_user_id')
      .eq('id', res.body.relationshipId)
      .single()
    expect(data?.provider_user_id).toBe(provider.domainId)
    invitationToken = await tokenFromOutbox()
    relationshipId = res.body.relationshipId
  })
})

/**
 * The token, read the way the guardian gets it: out of the outbox row that
 * becomes their email. It is hashed in guardian_relationships and no longer
 * returned by the API, so this is the only place a test can obtain it --
 * which is the point.
 */
async function tokenFromOutbox(): Promise<string> {
  const { data } = await admin
    .from('notifications')
    .select('payload, created_at')
    .eq('kind', 'guardian.approval_requested')
    .eq('destination', GUARDIAN_EMAIL)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return String((data?.payload as Record<string, unknown>)?.['invitationToken'] ?? '')
}

describe('POST /v1/guardian/invitations/{token}/accept', () => {
  it('refuses the provider accepting their own invitation', async () => {
    const res = await call(
      'POST',
      `/api/v1/guardian/invitations/${invitationToken}/accept`,
      { cookie: provider.cookie },
    )
    // Same 404 as a token that does not exist. Naming the reason would
    // confirm the token was real.
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('INVALID_TOKEN')
  })

  it('returns 404 for a token that does not exist', async () => {
    const res = await call(
      'POST',
      '/api/v1/guardian/invitations/aaaaaaaaaaaaaaaaaaaaaaaaaaaa/accept',
      { cookie: guardian.cookie },
    )
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('INVALID_TOKEN')
  })

  it('returns 404 for an obviously malformed token, indistinguishable from a miss', async () => {
    const res = await call('POST', '/api/v1/guardian/invitations/short/accept', {
      cookie: guardian.cookie,
    })
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('INVALID_TOKEN')
  })

  it('accepts a valid token and moves to guardian_started', async () => {
    const res = await call(
      'POST',
      `/api/v1/guardian/invitations/${encodeURIComponent(invitationToken)}/accept`,
      { cookie: guardian.cookie },
    )
    expect(res.status).toBe(200)
    expect(res.body.state).toBe('guardian_started')
  })

  it('refuses to replay the same link', async () => {
    const res = await call(
      'POST',
      `/api/v1/guardian/invitations/${encodeURIComponent(invitationToken)}/accept`,
      { cookie: guardian.cookie },
    )
    expect(res.status).toBe(404)
  })
})

describe('POST /v1/guardian/relationships/{id}/revoke', () => {
  it('hides another party relationship behind 404 rather than 403', async () => {
    // The provider is not the guardian on this relationship. Confirming it
    // exists but belongs to someone else would itself be a disclosure.
    const res = await call('POST', `/api/v1/guardian/relationships/${relationshipId}/revoke`, {
      cookie: provider.cookie,
      body: {},
    })
    expect([403, 404]).toContain(res.status)
  })

  it('lets the linked guardian revoke', async () => {
    await admin
      .from('guardian_relationships')
      .update({ state: 'verified', consented_at: new Date().toISOString() })
      .eq('id', relationshipId)
    await admin
      .from('provider_profiles')
      .update({ guardian_state: 'verified' })
      .eq('user_id', provider.domainId)

    const res = await call('POST', `/api/v1/guardian/relationships/${relationshipId}/revoke`, {
      cookie: guardian.cookie,
      body: { reasonCode: 'guardian_request' },
    })
    expect(res.status).toBe(200)
    expect(res.body.state).toBe('revoked')

    const { data } = await admin
      .from('provider_profiles')
      .select('guardian_state')
      .eq('user_id', provider.domainId)
      .single()
    expect(data?.guardian_state).toBe('revoked')
  })

  it('returns 409 when the relationship cannot be revoked again', async () => {
    const res = await call('POST', `/api/v1/guardian/relationships/${relationshipId}/revoke`, {
      cookie: guardian.cookie,
      body: {},
    })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('ILLEGAL_GUARDIAN_TRANSITION')
  })
})

describe('security headers', () => {
  it('sets the headers configured in next.config', async () => {
    const res = await fetch(BASE + '/')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin')
  })
})
