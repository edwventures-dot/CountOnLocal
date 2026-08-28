/**
 * Closing an account, over real HTTP.
 *
 * The service layer is covered by src/server/__tests__/retention.integration
 * .test.ts. What only the route can prove: that a signed-in person reaches
 * it, that it refuses an unauthenticated caller, that it will not close
 * somebody else's account, and that the proxy stops a closed account doing
 * anything afterwards.
 *
 * That last one matters most. users.status has been read by nothing before
 * -- a suspended account could do everything an active one could until that
 * was fixed -- and 'closed' is a second value down the same path.
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

const stamp = Date.now()
const PASSWORD = `Test-${stamp}-Aa1!`
let cookie = ''
let userId = ''
let email = ''

async function cookieHeaderFor(address: string): Promise<string> {
  const anon = createClient(url, anonKey, { auth: { persistSession: false } })
  const { data, error } = await anon.auth.signInWithPassword({
    email: address,
    password: PASSWORD,
  })
  if (error || !data.session) throw new Error(`sign in failed: ${error?.message}`)

  const jar = new Map<string, string>()
  const server = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
      setAll: (list) => list.forEach((c) => jar.set(c.name, c.value)),
    },
  })
  await server.auth.setSession({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
  })
  if (jar.size === 0) throw new Error('no auth cookies were produced')
  return [...jar.entries()].map(([n, v]) => `${n}=${encodeURIComponent(v)}`).join('; ')
}

async function call(method: string, path: string, opts: { cookie?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.cookie) headers['Cookie'] = opts.cookie
  const res = await fetch(BASE + path, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  })
  const text = await res.text()
  let body: unknown = null
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: res.status, body: body as Record<string, unknown> }
}

beforeAll(async () => {
  email = `closure-${stamp}@countonlocal.com`
  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  })
  if (error || !created.user) throw new Error(`createUser failed: ${error?.message}`)

  const { data: domainUser } = await admin
    .from('users')
    .select('id')
    .eq('auth_user_id', created.user.id)
    .single()
  userId = domainUser!.id
  cookie = await cookieHeaderFor(email)
})

afterAll(async () => {
  if (!userId) return
  // The safety-carve-out test files a real incident. Left behind it would
  // sit in the trust and safety queue as a report nobody can action.
  await admin.from('incidents').delete().eq('reporter_user_id', userId)
  await admin.from('notifications').delete().eq('recipient_user_id', userId)
  await admin.from('customer_addresses').delete().eq('customer_user_id', userId)
  await admin.from('audit_log').delete().eq('target_id', userId)
  const { data: u } = await admin.from('users').select('auth_user_id').eq('id', userId).maybeSingle()
  await admin.from('users').delete().eq('id', userId)
  if (u?.auth_user_id) await admin.auth.admin.deleteUser(u.auth_user_id).catch(() => {})
})

describe('telling somebody what closure does, before they do it', () => {
  it('refuses an unauthenticated caller', async () => {
    const res = await call('GET', '/api/v1/account/close')
    expect(res.status).toBe(401)
  })

  it('describes what is erased and what is kept, with reasons', async () => {
    const res = await call('GET', '/api/v1/account/close', { cookie })
    expect(res.status).toBe(200)

    const effect = (res.body as any).effect
    expect(effect.erasedImmediately.length).toBeGreaterThan(0)
    expect(effect.keptForNow.length).toBeGreaterThan(0)

    // The specific failure this guards: a confirmation screen that says
    // "this cannot be undone" while seven years of ledger is retained.
    const kept = effect.keptForNow.map((k: any) => k.what)
    expect(kept).toContain('ledger_entry')
    for (const k of effect.keptForNow) {
      expect(typeof k.because, k.what).toBe('string')
      expect(k.forDays, k.what).toBeGreaterThan(0)
    }
  })
})

describe('closing it', () => {
  it('closes the caller’s own account and says what it did', async () => {
    const res = await call('POST', '/api/v1/account/close', {
      cookie,
      body: { reason: 'finished with the service' },
    })
    expect(res.status).toBe(200)
    expect((res.body as any).closed).toBe(true)
    expect((res.body as any).effect.keptForNow.length).toBeGreaterThan(0)
  })

  it('replaced the email with an undeliverable address', async () => {
    const { data } = await admin
      .from('users')
      .select('status, email, de_identified_at')
      .eq('id', userId)
      .single()

    expect(data!.status).toBe('closed')
    expect(data!.email).not.toBe(email)
    expect(data!.email?.endsWith('.invalid')).toBe(true)
    expect(data!.de_identified_at).toBeTruthy()
  })

  it('stops the closed account taking any further action', async () => {
    // users.status is read centrally at the proxy rather than per route.
    // Before that existed a suspended account could do everything an
    // active one could, and 'closed' travels the same path.
    const res = await call('POST', '/api/v1/subscriptions', {
      cookie,
      body: { providerServiceId: '00000000-0000-0000-0000-000000000000' },
    })
    expect([401, 403]).toContain(res.status)
  })

  it('still lets it report a safety concern', async () => {
    // The one deliberate carve-out in the proxy. Somebody who witnesses
    // something dangerous must be able to say so, and closing an account
    // is not a reason to silence them -- the report is about somebody
    // else. Pinned here because it reads like a hole and is not one.
    const res = await call('POST', '/api/v1/incidents', {
      cookie,
      body: {
        category: 'other',
        narrative: 'A closed account must still be able to file this report.',
      },
    })
    expect(res.status).toBe(201)
  })
})
