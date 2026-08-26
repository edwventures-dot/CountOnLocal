/**
 * Read the waitlist.
 *
 *   npm run waitlist            recent signups + totals
 *   npm run waitlist -- --all   every row
 *   npm run waitlist -- --csv   CSV to stdout, for import elsewhere
 *
 * Exists because waitlist_signups is deliberately unreachable through the
 * API: row level security denies everything and 0016 revoked the anon and
 * authenticated grants, so PostgREST returns 401 rather than an email list.
 * That is the right posture for a public site and it leaves no way to check
 * the list short of opening the Supabase dashboard. This is that way.
 *
 * Connects with DATABASE_URL, so it only runs where that is set -- your
 * machine, not the deployed app.
 */

import pg from 'pg'

const args = new Set(process.argv.slice(2))
const wantAll = args.has('--all')
const wantCsv = args.has('--csv')

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  console.error('DATABASE_URL is not set. Run through npm so --env-file=.env.local applies.')
  process.exit(1)
}

const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } })
await client.connect()

const { rows: all } = await client.query(
  `select email, role, postal_code, created_at
     from waitlist_signups
    order by created_at desc
    ${wantAll || wantCsv ? '' : 'limit 20'}`,
)

if (wantCsv) {
  console.log('email,role,postal_code,created_at')
  for (const r of all) {
    console.log([r.email, r.role, r.postal_code ?? '', r.created_at.toISOString()].join(','))
  }
  await client.end()
  process.exit(0)
}

const { rows: byRole } = await client.query(
  `select role, count(*)::int n from waitlist_signups group by role order by n desc`,
)

// Density is the whole reason postal_code is collected -- GO_TO_MARKET picks
// the first market by where demand clusters, not by total signups.
const { rows: byZip } = await client.query(
  `select postal_code, count(*)::int n
     from waitlist_signups
    where postal_code is not null
    group by postal_code
    having count(*) > 0
    order by n desc, postal_code
    limit 12`,
)

const total = all.length && !wantAll ? null : all.length
const { rows: totalRow } = await client.query('select count(*)::int n from waitlist_signups')

console.log('')
console.log(`  Waitlist -- ${totalRow[0].n} signup(s)`)
console.log('')

if (totalRow[0].n === 0) {
  console.log('  Nobody yet.')
  console.log('')
  await client.end()
  process.exit(0)
}

console.log('  By audience')
for (const r of byRole) console.log(`    ${String(r.n).padStart(5)}  ${r.role}`)
console.log('')

if (byZip.length) {
  console.log('  By ZIP -- where a first market could open')
  for (const r of byZip) console.log(`    ${String(r.n).padStart(5)}  ${r.postal_code}`)
  console.log('')
}

console.log(wantAll ? '  All signups' : `  Most recent ${all.length}`)
for (const r of all) {
  const when = r.created_at.toISOString().slice(0, 16).replace('T', ' ')
  const zip = r.postal_code ?? '     '
  console.log(`    ${when}  ${zip.padEnd(6)} ${r.role.padEnd(9)} ${r.email}`)
}
console.log('')

if (!wantAll && totalRow[0].n > all.length) {
  console.log(`  ${totalRow[0].n - all.length} more -- npm run waitlist -- --all`)
  console.log('')
}

await client.end()
