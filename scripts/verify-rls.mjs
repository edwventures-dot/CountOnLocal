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
