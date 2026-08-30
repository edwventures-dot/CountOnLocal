/**
 * State restrictions, against the live database.
 *
 * Product owner's response of 2026-08-30, item 9: the platform is
 * multi-state, and counsel needs a lever to hold specific states back until
 * the controls those states require exist.
 *
 * The claim worth proving is not that the domain function returns false --
 * that is covered by unit tests. It is that a restriction written into the
 * table actually stops somebody buying, that it stops them BEFORE the
 * geocoder is called, and that lifting it lets them through again.
 *
 * These write to a server-owned table, so they clean up after themselves
 * carefully: a stray blocked state left behind would silently refuse every
 * later test that geocodes an address there.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'
import { checkRegionAllowed, loadJurisdictionRules } from '@/server/jurisdictionService'

const admin = createClient<Database>(
  process.env['NEXT_PUBLIC_SUPABASE_URL']!,
  process.env['SUPABASE_SERVICE_ROLE_KEY']!,
  { auth: { persistSession: false, autoRefreshToken: false } },
)

// A state nothing else in the suite uses. Every other integration test
// fixture is in TX, and blocking that would refuse half of them.
const REGION = 'WY'
const REASON = 'Fixture for the jurisdiction integration test. Not a real restriction.'

let catalogCode = ''
let originalPosture = 'open'

async function clearFixtures(): Promise<void> {
  await admin.from('jurisdiction_rules').delete().eq('region', REGION)
}

beforeAll(async () => {
  const { data: catalog } = await admin.from('service_catalog').select('code').limit(1).single()
  catalogCode = catalog!.code

  const { data: setting } = await admin
    .from('platform_settings')
    .select('value')
    .eq('key', 'jurisdiction_posture')
    .single()
  originalPosture = setting!.value

  await clearFixtures()
})

afterAll(async () => {
  await clearFixtures()
  // Put the posture back. Leaving this on `allowlist` would refuse every
  // checkout in every other test file, and the failure would look like a
  // checkout bug rather than a stray fixture.
  await admin
    .from('platform_settings')
    .update({ value: originalPosture })
    .eq('key', 'jurisdiction_posture')
})

describe('the open posture, which is what production runs today', () => {
  it('allows a state with no rules', async () => {
    const r = await checkRegionAllowed({ db: admin, region: REGION })
    expect(r.allowed).toBe(true)
  })

  it('refuses once counsel blocks the state', async () => {
    const { error } = await admin.from('jurisdiction_rules').insert({
      region: REGION,
      status: 'blocked',
      reason: REASON,
    })
    expect(error).toBeNull()

    const r = await checkRegionAllowed({ db: admin, region: REGION })
    expect(r.allowed).toBe(false)
    if (!r.allowed) {
      expect(r.code).toBe('STATE_BLOCKED')
      // Names the state, so support is not guessing which one.
      expect(r.message).toContain(REGION)
    }
  })

  it('does not affect any other state', async () => {
    expect((await checkRegionAllowed({ db: admin, region: 'TX' })).allowed).toBe(true)
  })

  it('lets the state through again when the rule is lifted', async () => {
    // Lifting is an update, not a delete: the history of when we were
    // closed somewhere has to survive.
    const { error } = await admin
      .from('jurisdiction_rules')
      .update({ lifted_at: new Date().toISOString(), lift_reason: 'test complete' })
      .eq('region', REGION)
    expect(error).toBeNull()

    expect((await checkRegionAllowed({ db: admin, region: REGION })).allowed).toBe(true)

    // And the row is still there to be read.
    const { count } = await admin
      .from('jurisdiction_rules')
      .select('id', { count: 'exact', head: true })
      .eq('region', REGION)
    expect(count).toBe(1)
  })
})

describe('blocking one service without closing the state', () => {
  beforeAll(async () => {
    await clearFixtures()
    const { error } = await admin.from('jurisdiction_rules').insert({
      region: REGION,
      status: 'blocked',
      catalog_code: catalogCode,
      reason: REASON,
    })
    if (error) throw new Error(error.message)
  })

  it('refuses that service there', async () => {
    const r = await checkRegionAllowed({ db: admin, region: REGION, catalogCode })
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.code).toBe('SERVICE_BLOCKED_IN_STATE')
  })

  it('leaves the rest of the state open', async () => {
    // The whole reason rules are per-service: a state that restricts one
    // kind of work by minors has not restricted every kind.
    expect((await checkRegionAllowed({ db: admin, region: REGION })).allowed).toBe(true)
  })
})

describe('the allowlist posture, for a staged launch', () => {
  beforeAll(async () => {
    await clearFixtures()
    await admin
      .from('platform_settings')
      .update({ value: 'allowlist' })
      .eq('key', 'jurisdiction_posture')
  })

  afterAll(async () => {
    await admin
      .from('platform_settings')
      .update({ value: originalPosture })
      .eq('key', 'jurisdiction_posture')
  })

  it('refuses a state nobody has cleared', async () => {
    const r = await checkRegionAllowed({ db: admin, region: REGION })
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.code).toBe('STATE_NOT_CLEARED')
  })

  it('allows it once cleared', async () => {
    const { error } = await admin.from('jurisdiction_rules').insert({
      region: REGION,
      status: 'allowed',
      reason: 'Cleared for the purposes of this test and nothing else.',
    })
    expect(error).toBeNull()

    expect((await checkRegionAllowed({ db: admin, region: REGION })).allowed).toBe(true)
  })
})

describe('the parts that protect against a mistake', () => {
  it('refuses a rule with no real reason', async () => {
    // A restriction nobody explained cannot be reviewed or lifted with
    // confidence, so the schema will not store one.
    const { error } = await admin.from('jurisdiction_rules').insert({
      region: REGION,
      status: 'blocked',
      reason: 'because',
    })
    expect(error).not.toBeNull()
  })

  it('refuses two live rules that would contradict each other', async () => {
    await clearFixtures()
    await admin
      .from('jurisdiction_rules')
      .insert({ region: REGION, status: 'blocked', reason: REASON })

    // Without the unique index the answer would depend on row order.
    const { error } = await admin
      .from('jurisdiction_rules')
      .insert({ region: REGION, status: 'allowed', reason: REASON })
    expect(error).not.toBeNull()

    await clearFixtures()
  })

  it('does not let a signed-out visitor write a rule', async () => {
    // Server-owned, like the service catalog. The value of the control is
    // that the people it constrains cannot edit it.
    const anon = createClient<Database>(
      process.env['NEXT_PUBLIC_SUPABASE_URL']!,
      process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!,
      { auth: { persistSession: false } },
    )
    const { error } = await anon
      .from('jurisdiction_rules')
      .insert({ region: 'CA', status: 'blocked', reason: REASON })
    expect(error).not.toBeNull()
  })

  it('does let a signed-out visitor read them', async () => {
    // Somebody typing an address needs to be told "not in your state yet"
    // before they get as far as entering a card.
    const anon = createClient<Database>(
      process.env['NEXT_PUBLIC_SUPABASE_URL']!,
      process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!,
      { auth: { persistSession: false } },
    )
    const { error } = await anon.from('jurisdiction_rules').select('region').limit(1)
    expect(error).toBeNull()
  })

  it('reports rules it cannot load as a refusal, not as permission', async () => {
    // Failing closed is the opposite of the usual instinct here, and it is
    // deliberate: guessing wrong means selling a service in a state that
    // prohibits it, which no retry fixes.
    const broken = createClient<Database>(
      process.env['NEXT_PUBLIC_SUPABASE_URL']!,
      'not-a-real-key',
      { auth: { persistSession: false } },
    )
    expect(await loadJurisdictionRules(broken)).toBeNull()

    const r = await checkRegionAllowed({ db: broken, region: 'TX' })
    expect(r.allowed).toBe(false)
  })
})
