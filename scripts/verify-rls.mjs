/**
 * Proves row level security is actually on.
 *
 * The anon key ships inside the browser bundle by design, so "can an
 * unauthenticated caller read this" is not a theoretical question -- it is
 * exactly what an attacker has. This script asks it directly, against the
 * live REST API, using the same key any visitor would hold.
 *
 * Written after discovering that the tables from migration 0001 were both
 * readable AND writable by anon before migration 0002 added policies.
 *
 *   node --env-file=.env.local scripts/verify-rls.mjs
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !anonKey || !serviceKey) {
  console.error('\n  Missing Supabase environment. See .env.example\n')
  process.exit(1)
}

const TABLES = [
  'users',
  'user_roles',
  'provider_profiles',
  'guardian_profiles',
  'guardian_relationships',
  'audit_log',
  'waitlist_signups',
  // A referral names the customer who used a provider's code. On this
  // platform the reader is often a minor and the subject is their
  // neighbour, so an anonymous read here would be a way to learn that a
  // specific household signed up.
  'referrals',
  'referral_codes',
  'ledger_entries',
  // Signed consents name a minor and carry a guardian's legal signature.
  'consent_records',
  // Reason text on a sanction would identify who reported somebody.
  'account_actions',
]

let passed = 0
let failed = 0

const pass = (m) => (console.log(`  PASS  ${m}`), passed++)
const fail = (m, d) => (console.log(`  FAIL  ${m}`), d && console.log(`        ${d}`), failed++)

const headers = (key) => ({ apikey: key, Authorization: `Bearer ${key}` })

async function main() {
  console.log('\n  Anonymous read -- every one of these must be refused\n')
  for (const t of TABLES) {
    const r = await fetch(`${url}/rest/v1/${t}?select=*&limit=1`, { headers: headers(anonKey) })
    if (r.status === 200) {
      const rows = await r.json().catch(() => [])
      fail(`anon cannot read ${t}`, `HTTP 200, returned ${rows.length} row(s)`)
    } else {
      pass(`anon cannot read ${t} (HTTP ${r.status})`)
    }
  }

  // A view is not a table, so the list above never covered one. Supabase
  // flagged this project on 2026-10-17 and the audit that followed found
  // both retention clocks readable -- and, because Postgres made them
  // auto-updatable, deletable -- by anon, straight through postgres's
  // BYPASSRLS. Migration 0047 closed it. These two must stay refused.
  console.log('\n  Anonymous read of internal views -- must be refused\n')
  for (const v of ['account_retention_clock', 'address_retention_clock']) {
    const r = await fetch(`${url}/rest/v1/${v}?select=*&limit=1`, { headers: headers(anonKey) })
    if (r.status === 200) {
      const rows = await r.json().catch(() => [])
      fail(`anon cannot read ${v}`, `HTTP 200, returned ${rows.length} row(s)`)
    } else {
      pass(`anon cannot read ${v} (HTTP ${r.status})`)
    }
  }

  // The same view, asked to destroy rather than read. It deleted from
  // users when this was first probed.
  {
    const r = await fetch(`${url}/rest/v1/account_retention_clock?user_id=not.is.null`, {
      method: 'DELETE',
      headers: headers(anonKey),
    })
    r.status < 300
      ? fail('anon cannot delete through account_retention_clock', `HTTP ${r.status}`)
      : pass(`anon cannot delete through account_retention_clock (HTTP ${r.status})`)
  }

  // Positive control. public_service_areas is meant to be public: it is
  // how a visitor sees which neighbourhoods a provider covers. If this
  // one starts failing, the storefront map is broken, not secured.
  console.log('\n  The view that is meant to be public -- must be allowed\n')
  {
    const r = await fetch(`${url}/rest/v1/public_service_areas?select=provider_service_id&limit=1`, {
      headers: headers(anonKey),
    })
    r.status === 200
      ? pass('anon can read public_service_areas')
      : fail('anon can read public_service_areas', `HTTP ${r.status}`)
  }

  console.log('\n  Anonymous write -- must be refused\n')
  const probeEmail = `rls-probe-${Date.now()}@example.invalid`
  const w = await fetch(`${url}/rest/v1/users`, {
    method: 'POST',
    headers: { ...headers(anonKey), 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: probeEmail }),
  })
  if (w.status < 300) {
    fail('anon cannot insert into users', `HTTP ${w.status} -- a row was created`)
    // Clean up immediately rather than leaving the probe row behind.
    await fetch(`${url}/rest/v1/users?email=eq.${encodeURIComponent(probeEmail)}`, {
      method: 'DELETE',
      headers: headers(serviceKey),
    })
  } else {
    pass(`anon cannot insert into users (HTTP ${w.status})`)
  }

  console.log('\n  Service role -- server paths must still work\n')
  for (const t of ['audit_log', 'provider_profiles']) {
    const r = await fetch(`${url}/rest/v1/${t}?select=*&limit=1`, { headers: headers(serviceKey) })
    r.status === 200
      ? pass(`service role can read ${t}`)
      : fail(`service role can read ${t}`, `HTTP ${r.status}`)
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('\n  ' + (e.stack ?? String(e)) + '\n')
  process.exit(1)
})
