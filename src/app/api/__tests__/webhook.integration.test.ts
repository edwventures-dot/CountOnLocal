/**
 * Stripe webhook handler, driven over real HTTP.
 *
 * Signatures are generated with the SDK rather than forwarded by the Stripe
 * CLI. That is deliberate: it lets the suite assert the rejection paths --
 * missing signature, wrong secret, tampered body -- which a CLI that only
 * ever sends valid traffic cannot exercise.
 *
 *   npx next dev -p 3100
 *   npm run test:http
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'
import type { Database } from '@/lib/supabase/types'

const BASE = process.env['E2E_BASE_URL'] ?? 'http://localhost:3100'
const url = process.env['NEXT_PUBLIC_SUPABASE_URL']!
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY']!
const webhookSecret = process.env['STRIPE_WEBHOOK_SECRET']!

const admin = createClient<Database>(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})
const sdk = new Stripe(process.env['STRIPE_SECRET_KEY']!, { apiVersion: '2026-07-29.dahlia' })

const WEBHOOK_PATH = '/api/webhooks/stripe'
const stamp = Date.now()
const eventIds: string[] = []

function signedHeaders(payload: string): Record<string, string> {
  const header = sdk.webhooks.generateTestHeaderString({ payload, secret: webhookSecret })
  return { 'Content-Type': 'application/json', 'stripe-signature': header }
}

function makeEvent(overrides: Record<string, unknown> = {}): string {
  const id = `evt_test_${stamp}_${eventIds.length}`
  eventIds.push(id)
  return JSON.stringify({
    id,
    object: 'v2.core.event',
    type: 'v2.core.account[configuration.recipient].capability_status_updated',
    created: new Date().toISOString(),
    api_version: '2026-07-29.dahlia',
    related_object: { id: 'acct_doesnotexist', type: 'v2.core.account' },
    ...overrides,
  })
}

async function post(body: string, headers: Record<string, string>) {
  const res = await fetch(BASE + WEBHOOK_PATH, { method: 'POST', headers, body })
  const text = await res.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = text
  }
  return { status: res.status, body: json }
}

beforeAll(async () => {
  const ping = await fetch(BASE + '/').catch(() => null)
  if (!ping) throw new Error(`No dev server at ${BASE}. Start it with: npx next dev -p 3100`)
})

afterAll(async () => {
  for (const id of eventIds) await admin.from('stripe_events').delete().eq('id', id)
})

describe('signature verification', () => {
  it('rejects a request with no signature header', async () => {
    const res = await post(makeEvent(), { 'Content-Type': 'application/json' })
    expect(res.status).toBe(400)
  })

  it('rejects a signature made with the wrong secret', async () => {
    const payload = makeEvent()
    const bad = sdk.webhooks.generateTestHeaderString({
      payload,
      secret: 'whsec_' + 'f'.repeat(64),
    })
    const res = await post(payload, {
      'Content-Type': 'application/json',
      'stripe-signature': bad,
    })
    expect(res.status).toBe(400)
  })

  it('rejects a body tampered with after signing', async () => {
    const original = makeEvent()
    const headers = signedHeaders(original)
    const tampered = original.replace('acct_doesnotexist', 'acct_attacker')
    const res = await post(tampered, headers)
    expect(res.status).toBe(400)
  })

  it('accepts a correctly signed event', async () => {
    const payload = makeEvent()
    const res = await post(payload, signedHeaders(payload))
    expect(res.status).toBe(200)
    expect(res.body.received).toBe(true)
  })
})

describe('the event is recorded', () => {
  it('persists id, type and the referenced account', async () => {
    const payload = makeEvent()
    await post(payload, signedHeaders(payload))
    const id = JSON.parse(payload).id

    const { data } = await admin.from('stripe_events').select('*').eq('id', id).single()
    expect(data?.type).toBe('v2.core.account[configuration.recipient].capability_status_updated')
    expect(data?.account_id).toBe('acct_doesnotexist')
    expect(data?.processed_at).toBeTruthy()
  })

  it('does not treat an unknown account as a failure worth retrying', async () => {
    // The account is not one we hold. Recording it and moving on is correct;
    // a 500 would make Stripe retry forever.
    const payload = makeEvent()
    const res = await post(payload, signedHeaders(payload))
    expect(res.status).toBe(200)
    const { data } = await admin
      .from('stripe_events')
      .select('error')
      .eq('id', JSON.parse(payload).id)
      .single()
    expect(data?.error).toBeNull()
  })
})

describe('de-duplication', () => {
  it('acknowledges a replayed event without reprocessing it', async () => {
    const payload = makeEvent()
    const headers = signedHeaders(payload)

    const first = await post(payload, headers)
    expect(first.status).toBe(200)
    expect(first.body.duplicate).toBeUndefined()

    const second = await post(payload, headers)
    expect(second.status).toBe(200)
    expect(second.body.duplicate).toBe(true)

    // Exactly one row, whatever Stripe does.
    const { count } = await admin
      .from('stripe_events')
      .select('id', { count: 'exact', head: true })
      .eq('id', JSON.parse(payload).id)
    expect(count).toBe(1)
  })
})

describe('events that name no account', () => {
  it('are recorded and acknowledged without a Stripe round trip', async () => {
    const payload = makeEvent({
      type: 'v2.core.account_link.returned',
      related_object: { id: 'acctlink_123', type: 'v2.core.account_link' },
    })
    const res = await post(payload, signedHeaders(payload))
    expect(res.status).toBe(200)

    const { data } = await admin
      .from('stripe_events')
      .select('account_id, processed_at')
      .eq('id', JSON.parse(payload).id)
      .single()
    expect(data?.account_id).toBeNull()
    expect(data?.processed_at).toBeTruthy()
  })
})

describe('the event log is not client readable', () => {
  it('refuses the anon key', async () => {
    const anon = createClient<Database>(url, process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data, error } = await anon.from('stripe_events').select('id').limit(1)
    expect(error ?? (data?.length === 0 ? 'empty' : null)).toBeTruthy()
  })
})
