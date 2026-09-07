/**
 * The invite gate, against the live database.
 *
 * This is a safety control, so it is tested by trying to get past it rather
 * than by reading the trigger. Signup happens in the browser -- AuthForm
 * calls supabase.auth.signUp directly with the public anon key -- so a
 * check that lived in React would be a suggestion. The only claim worth
 * asserting is that an account cannot be created, by anyone, through any
 * client, when the address is not on the list.
 *
 * The admin API is used here deliberately: it is the MOST privileged way to
 * create a user. If the gate holds against the service role, it holds
 * against a browser.
 *
 * The flag is restored in afterAll, and every path out of these tests goes
 * through it -- leaving invite-only ON would lock the owner out of their
 * own signup, and leaving it OFF after a failure would silently open the
 * pilot.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'

const url = process.env['NEXT_PUBLIC_SUPABASE_URL']!
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY']!
const admin = createClient<Database>(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const stamp = Date.now()
const PASSWORD = `Test-${stamp}-Aa1!`

const INVITED = `pilot-invited-${stamp}@gmail.com`
const STRANGER = `pilot-stranger-${stamp}@gmail.com`
const SUITE = `pilot-suite-${stamp}@example.com`

const created: string[] = []
let flagWas = 'off'

async function setFlag(value: 'on' | 'off') {
  const { error } = await admin
    .from('platform_settings')
    .update({ value })
    .eq('key', 'pilot_invite_only')
  if (error) throw new Error(`could not set flag: ${error.message}`)
}

async function trySignup(email: string): Promise<boolean> {
  const { data } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  })
  if (data?.user) {
    created.push(data.user.id)
    return true
  }
  return false
}

beforeAll(async () => {
  const { data } = await admin
    .from('platform_settings')
    .select('value')
    .eq('key', 'pilot_invite_only')
    .maybeSingle()
  flagWas = data?.value ?? 'off'

  await admin.from('pilot_invites').insert({ email: INVITED, note: 'integration test' })
})

afterAll(async () => {
  await setFlag(flagWas === 'on' ? 'on' : 'off')
  await admin.from('pilot_invites').delete().in('email', [INVITED, STRANGER])
  for (const id of created) await admin.auth.admin.deleteUser(id).catch(() => {})
})

describe('while the pilot is open to anyone', () => {
  it('lets a stranger create an account', async () => {
    await setFlag('off')
    expect(await trySignup(`pilot-open-${stamp}@gmail.com`)).toBe(true)
  })
})

describe('while the pilot is invite-only', () => {
  beforeAll(() => setFlag('on'))

  it('refuses an address nobody invited, even through the service role', async () => {
    // The claim the whole control rests on.
    expect(await trySignup(STRANGER)).toBe(false)
  })

  it('creates no account at all for a refused address', async () => {
    // BEFORE INSERT rather than AFTER: a half-created credential would be
    // worse than a refusal, because the address would then be unusable
    // when they were later invited.
    const { data } = await admin.auth.admin.listUsers()
    const leaked = data?.users?.some((u) => u.email?.toLowerCase() === STRANGER)
    expect(leaked ?? false).toBe(false)
  })

  it('lets an invited neighbour in', async () => {
    expect(await trySignup(INVITED)).toBe(true)
  })

  it('records when an invitation was taken up', async () => {
    const { data } = await admin
      .from('pilot_invites')
      .select('redeemed_at')
      .eq('email', INVITED)
      .single()
    expect(data?.redeemed_at).toBeTruthy()
  })

  it('still lets the test suite create users, or it would break everything', async () => {
    // 416 integration tests create @example.com users against this same
    // database. Without this exemption, switching the gate on would break
    // the suite -- which is exactly how a safety control gets switched back
    // off and left off. example.com is reserved by RFC 2606, so no real
    // neighbour can have one.
    expect(await trySignup(SUITE)).toBe(true)
  })
})
