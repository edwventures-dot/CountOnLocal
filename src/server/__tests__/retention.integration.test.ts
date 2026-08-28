/**
 * Retention and account closure, against the live database.
 *
 * The claims here are about data being gone, and "gone" is the one thing
 * that cannot be checked by reading code -- absence is silent, which is
 * exactly how six declared-but-unwired capabilities survived in this
 * codebase. So every assertion reads the row back afterwards and looks for
 * the value that should no longer be there.
 *
 * Two of these fabricate rows dated years in the past. The consent
 * redaction path will not fire in production until 2033, and a sweep first
 * exercised in 2033 is a sweep first debugged in 2033, against the oldest
 * and least reconstructable rows in the database.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'
import { closeAccount, runRetention } from '@/server/retentionJob'
import { deletionEffect, REDACTED, RETENTION, sweptClasses } from '@/domain/retention'

const admin = createClient<Database>(
  process.env['NEXT_PUBLIC_SUPABASE_URL']!,
  process.env['SUPABASE_SERVICE_ROLE_KEY']!,
  { auth: { persistSession: false, autoRefreshToken: false } },
)

const stamp = Date.now()
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()

let customerId = ''
let providerId = ''
let guardianId = ''
let addressId = ''

async function makeUser(tag: string): Promise<string> {
  const { data: created, error } = await admin.auth.admin.createUser({
    email: `retention-${tag}-${stamp}@countonlocal.com`,
    password: `Test-${stamp}-Aa1!`,
    email_confirm: true,
  })
  if (error || !created?.user) throw new Error(`createUser failed: ${error?.message}`)
  const { data } = await admin
    .from('users')
    .select('id')
    .eq('auth_user_id', created.user.id)
    .single()
  return data!.id
}

beforeAll(async () => {
  customerId = await makeUser('customer')
  providerId = await makeUser('provider')
  guardianId = await makeUser('guardian')

  const { data: address, error } = await admin
    .from('customer_addresses')
    .insert({
      customer_user_id: customerId,
      line1: '742 Evergreen Terrace',
      city: 'Springfield',
      region: 'OR',
      postal_code: '97477',
      access_notes: 'Gate code 4417',
      // Long past the 180-day period, and with no subscription ever
      // attached, so the clock has been running since the row was created.
      created_at: daysAgo(400),
    })
    .select('id')
    .single()
  if (error) throw new Error(error.message)
  addressId = address.id

  // A real geocoded point, so "the sweep cleared it" is a claim about
  // something that was actually there. Written through the function
  // because PostgREST cannot insert a geography literal.
  const { error: pointError } = await admin.rpc('set_customer_address_point' as never, {
    p_address_id: addressId,
    p_lat: 44.0462,
    p_lng: -123.0221,
  } as never)
  if (pointError) throw new Error(pointError.message)

  const { error: notifyError } = await admin.from('notifications').insert([
    {
      kind: 'test.old_sent',
      channel: 'email',
      state: 'sent',
      recipient_user_id: customerId,
      destination: `retention-customer-${stamp}@countonlocal.com`,
      sent_at: daysAgo(200),
      created_at: daysAgo(200),
    },
    {
      kind: 'test.recent',
      channel: 'email',
      state: 'sent',
      recipient_user_id: customerId,
      destination: `retention-customer-${stamp}@countonlocal.com`,
      sent_at: daysAgo(5),
      created_at: daysAgo(5),
    },
  ])
  if (notifyError) throw new Error(notifyError.message)
})

afterAll(async () => {
  for (const id of [customerId, providerId, guardianId].filter(Boolean)) {
    await admin.from('notifications').delete().eq('recipient_user_id', id)
    await admin.from('customer_addresses').delete().eq('customer_user_id', id)
    await admin.from('guardian_relationships').delete().eq('provider_user_id', id)
    await admin.from('provider_profiles').delete().eq('user_id', id)
    await admin.from('guardian_profiles').delete().eq('user_id', id)
    await admin.from('audit_log').delete().eq('target_id', id)
    const { data: u } = await admin.from('users').select('auth_user_id').eq('id', id).maybeSingle()
    await admin.from('users').delete().eq('id', id)
    if (u?.auth_user_id) await admin.auth.admin.deleteUser(u.auth_user_id).catch(() => {})
  }
})

describe('the daily sweep', () => {
  it('empties an address nothing has used for six months', async () => {
    await runRetention({ db: admin, now: new Date() })

    const { data } = await admin
      .from('customer_addresses')
      .select('line1, city, postal_code, access_notes, geocoded_at')
      .eq('id', addressId)
      .single()

    expect(data!.line1).toBe(REDACTED)
    // The gate code is the field SAFETY_TRUST_POLICY 14 restricts hardest.
    expect(data!.access_notes).toBeNull()
    expect(data!.postal_code).toBe('00000')
  })

  it('clears the coordinates, not only the text', async () => {
    // The failure this catches: PostgREST cannot WRITE a geography column,
    // so an ordinary update silently leaves `point` untouched. The sweep
    // would report success having cleared the street name while keeping a
    // more precise fix on the same house than the text ever was.
    const { data } = await admin
      .from('customer_addresses')
      .select('point, geocoded_at, geocoder')
      .eq('id', addressId)
      .single()

    expect(data!.point).toBeNull()
    expect(data!.geocoded_at).toBeNull()
    expect(data!.geocoder).toBeNull()
  })

  it('does not touch an address still inside its period', async () => {
    const { data: fresh } = await admin
      .from('customer_addresses')
      .insert({
        customer_user_id: customerId,
        line1: '1 Recent Street',
        city: 'Springfield',
        region: 'OR',
        postal_code: '97477',
      })
      .select('id')
      .single()

    await runRetention({ db: admin, now: new Date() })

    const { data } = await admin
      .from('customer_addresses')
      .select('line1')
      .eq('id', fresh!.id)
      .single()
    expect(data!.line1).toBe('1 Recent Street')
  })

  it('deletes an old notification and keeps a recent one', async () => {
    const { data } = await admin
      .from('notifications')
      .select('kind')
      .eq('recipient_user_id', customerId)

    const kinds = (data ?? []).map((n) => n.kind)
    // The destination is an email address, so the row goes rather than
    // being blanked.
    expect(kinds).not.toContain('test.old_sent')
    expect(kinds).toContain('test.recent')
  })

  it('reports every class it swept, so a silent no-op is visible', async () => {
    const result = await runRetention({ db: admin, now: new Date() })
    expect(result.failures).toEqual([])
    for (const c of sweptClasses()) {
      // message_flagged shares the messages sweep with message_ordinary.
      if (c === 'message_flagged') continue
      expect(Object.keys(result.expired), c).toContain(c)
    }
  })

  it('is idempotent: a second run finds nothing left to do', async () => {
    const again = await runRetention({ db: admin, now: new Date() })
    expect(again.expired.customer_address).toBe(0)
    expect(again.expired.notification).toBe(0)
  })
})

describe('closing an account', () => {
  it('refuses while money is still owed', async () => {
    // The money is the person's own. Closing over the top of it would
    // strand earnings in a ledger belonging to an account nobody can
    // contact -- and for a provider aged 13 to 17 that is a minor's money.
    const { error } = await admin.from('ledger_entries').insert({
      kind: 'provider_earning',
      amount_cents: -900,
      currency: 'USD',
      provider_user_id: providerId,
      memo: 'retention test earnings',
    })
    expect(error).toBeNull()

    const result = await closeAccount({
      db: admin,
      userId: providerId,
      actorUserId: providerId,
      actorRole: 'provider',
      reason: 'test',
      now: new Date(),
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('OWED_MONEY')

    // Still active. A refused closure must not half-close the account.
    const { data } = await admin.from('users').select('status').eq('id', providerId).single()
    expect(data!.status).toBe('active')

    await admin.from('ledger_entries').delete().eq('provider_user_id', providerId)
  })

  it('replaces the contact details rather than deleting the row', async () => {
    const result = await closeAccount({
      db: admin,
      userId: customerId,
      actorUserId: customerId,
      actorRole: 'customer',
      reason: 'no longer need the service',
      now: new Date(),
    })
    expect(result.ok).toBe(true)

    const { data } = await admin
      .from('users')
      .select('status, email, phone_e164, closed_at, de_identified_at')
      .eq('id', customerId)
      .single()

    // The row survives, because consent_records, completion_photos and the
    // incident tables all reference users with `on delete restrict`. Hard
    // deletion was never actually available.
    expect(data).toBeTruthy()
    expect(data!.status).toBe('closed')
    expect(data!.email).not.toContain('countonlocal.com')
    expect(data!.email?.endsWith('.invalid')).toBe(true)
    expect(data!.de_identified_at).toBeTruthy()
  })

  it('tells the person exactly what was kept and why', async () => {
    // The one outcome this must not have: telling somebody their data is
    // gone while seven years of it is retained.
    const effect = deletionEffect()
    expect(effect.retained.length).toBeGreaterThan(0)
    for (const r of effect.retained) {
      expect(r.because.length, r.class).toBeGreaterThan(20)
    }
    expect(effect.retained.map((r) => r.class)).toContain('ledger_entry')
  })

  it('is idempotent: closing twice does not fail or re-close', async () => {
    const { data: before } = await admin
      .from('users')
      .select('closed_at')
      .eq('id', customerId)
      .single()

    const result = await closeAccount({
      db: admin,
      userId: customerId,
      actorUserId: customerId,
      actorRole: 'customer',
      reason: 'again',
      now: new Date(),
    })
    expect(result.ok).toBe(true)

    const { data: after } = await admin
      .from('users')
      .select('closed_at')
      .eq('id', customerId)
      .single()
    // The original closure timestamp stands. Overwriting it would move the
    // retention clock forward every time the endpoint was called.
    expect(after!.closed_at).toBe(before!.closed_at)
  })

  it('writes an audit row that does not contain what it just erased', async () => {
    const { data } = await admin
      .from('audit_log')
      .select('action, after_json')
      .eq('target_id', customerId)
      .eq('action', 'account.de_identified')
      .limit(1)

    expect((data ?? []).length).toBeGreaterThan(0)
    // An audit row carrying the email address we just removed would put it
    // straight back, in a table kept for seven years.
    expect(JSON.stringify(data![0]!.after_json)).not.toContain('countonlocal.com')
  })
})

describe('signatures past their retention period', () => {
  it('redacts the signature and keeps the agreement', async () => {
    await admin.from('guardian_profiles').insert({ user_id: guardianId })
    await admin.from('provider_profiles').insert({
      user_id: providerId,
      date_of_birth: '2009-01-01',
      display_first_name: 'Sam',
      guardian_state: 'verified',
    })
    // Ended eight years ago: both halves of the clock are past.
    await admin.from('guardian_relationships').insert({
      provider_user_id: providerId,
      guardian_user_id: guardianId,
      state: 'revoked',
      revoked_at: daysAgo(8 * 365),
      consented_at: daysAgo(9 * 365),
      invitation_email: `retention-guardian-${stamp}@countonlocal.com`,
      invitation_expires_at: daysAgo(9 * 365),
    })

    const { data: consent, error } = await admin
      .from('consent_records')
      .insert({
        kind: 'guardian_consent',
        signer_user_id: guardianId,
        subject_user_id: providerId,
        document_version: '2026-08-28.2',
        document_hash: 'a'.repeat(64),
        document_text: 'x'.repeat(80),
        acknowledged_items: ['earnings'],
        typed_name: 'Pat Q Guardian',
        verification_method: 'authenticated_session',
        ip_hash: 'deadbeef',
        user_agent: 'test-agent',
        // Cast because signed_at is deliberately absent from the Insert
        // type: nothing in the application may choose when a signature
        // happened. Only this test, fabricating a record from 2017 so the
        // seven-year path runs today instead of first running in 2033.
        signed_at: daysAgo(9 * 365),
      } as never)
      .select('id')
      .single()
    expect(error).toBeNull()

    const result = await runRetention({ db: admin, now: new Date() })
    expect(result.failures).toEqual([])

    const { data } = await admin
      .from('consent_records')
      .select('typed_name, user_agent, ip_hash, document_hash, acknowledged_items, signed_at')
      .eq('id', consent!.id)
      .single()

    // The signature goes.
    expect(data!.typed_name).toBe(REDACTED)
    expect(data!.user_agent).toBeNull()
    expect(data!.ip_hash).toBeNull()
    // What was agreed, and when, does not. The record still shows that an
    // identified account accepted a specific document on a specific day.
    expect(data!.document_hash).toBe('a'.repeat(64))
    expect(data!.acknowledged_items).toEqual(['earnings'])

    await admin.from('consent_records').delete().eq('id', consent!.id).then(() => {})
  })

  it('leaves a signature inside its period alone', async () => {
    const { data: consent } = await admin
      .from('consent_records')
      .insert({
        kind: 'customer_attestation',
        signer_user_id: guardianId,
        document_version: '2026-08-28.2',
        document_hash: 'b'.repeat(64),
        document_text: 'y'.repeat(80),
        acknowledged_items: ['age'],
        typed_name: 'Recent Signer',
        verification_method: 'authenticated_session',
      })
      .select('id')
      .single()

    const result = await runRetention({ db: admin, now: new Date() })
    expect(result.failures).toEqual([])

    const { data } = await admin
      .from('consent_records')
      .select('typed_name')
      .eq('id', consent!.id)
      .single()
    expect(data!.typed_name).toBe('Recent Signer')
  })

  it('keeps the period the database enforces in step with the policy', async () => {
    // Migrations 0035 and 0036 hard-code seven years as an independent
    // check. If the policy is shortened and the trigger is not, the sweep
    // silently stops redacting and nothing fails.
    expect(RETENTION.consent_record.days).toBe(365 * 7)
  })
})
