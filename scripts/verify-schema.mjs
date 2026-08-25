/**
 * Proves the safety-critical constraints actually reject bad data.
 *
 * The application gates in src/domain are unit-tested, but QA_ACCEPTANCE
 * section 2 requires the under-13 rule to hold against a direct write, not
 * just against a well-behaved handler. This connects as the database owner
 * -- the most privileged caller there is -- and tries to insert the exact
 * rows that must be impossible.
 *
 * Everything runs inside one transaction that is always rolled back, so no
 * test rows survive even on success.
 *
 *   node --env-file=.env.local scripts/verify-schema.mjs
 */

import pg from 'pg'

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  console.error('\n  DATABASE_URL is not set. Add it to .env.local.\n')
  process.exit(1)
}

const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } })

let passed = 0
let failed = 0

function ok(label) {
  console.log(`  PASS  ${label}`)
  passed += 1
}
function bad(label, detail) {
  console.log(`  FAIL  ${label}`)
  if (detail) console.log(`        ${detail}`)
  failed += 1
}

/** Asserts the statement is rejected by the database. */
async function mustReject(label, sql, params, expectedConstraint) {
  try {
    await client.query('savepoint s')
    await client.query(sql, params)
    await client.query('rollback to savepoint s')
    bad(label, 'the insert SUCCEEDED but should have been rejected')
  } catch (err) {
    await client.query('rollback to savepoint s')
    if (expectedConstraint && !String(err.message).includes(expectedConstraint)) {
      bad(label, `rejected, but by "${err.constraint ?? err.message}"`)
    } else {
      ok(label)
    }
  }
}

async function mustAccept(label, sql, params) {
  try {
    await client.query('savepoint s')
    await client.query(sql, params)
    await client.query('rollback to savepoint s')
    ok(label)
  } catch (err) {
    await client.query('rollback to savepoint s')
    bad(label, err.message)
  }
}

const EXPECTED_TABLES = [
  'users',
  'user_roles',
  'provider_profiles',
  'guardian_profiles',
  'guardian_relationships',
  'audit_log',
]

async function main() {
  await client.connect()
  await client.query('begin')

  console.log('\n  Schema\n')
  const { rows } = await client.query(
    `select table_name from information_schema.tables
     where table_schema = 'public' and table_name = any($1)`,
    [EXPECTED_TABLES],
  )
  const found = new Set(rows.map((r) => r.table_name))
  for (const t of EXPECTED_TABLES) {
    found.has(t) ? ok(`table ${t} exists`) : bad(`table ${t} exists`, 'missing')
  }

  if (found.size !== EXPECTED_TABLES.length) {
    console.log('\n  Schema incomplete -- run the migration first.\n')
    await client.query('rollback')
    await client.end()
    process.exit(1)
  }

  // A user to hang the profiles off.
  const userId = '00000000-0000-4000-8000-00000000ffff'
  await client.query(
    `insert into users (id, email) values ($1, 'schema-check@example.invalid')`,
    [userId],
  )

  const insertProfile = `
    insert into provider_profiles (user_id, date_of_birth, display_first_name, guardian_state)
    values ($1, $2, 'Test', $3)`

  console.log('\n  Age gate -- QA_ACCEPTANCE section 2\n')

  await mustReject(
    'a 12-year-old provider is rejected at the database level',
    insertProfile,
    [userId, isoYearsAgo(12), 'required_uninvited'],
    'provider_min_age_13',
  )

  await mustAccept('a 13-year-old provider is accepted', insertProfile, [
    userId,
    isoYearsAgo(13),
    'required_uninvited',
  ])

  console.log('\n  Guardian requirement -- QA_ACCEPTANCE section 3\n')

  await mustReject(
    'a minor cannot be stored at not_required',
    insertProfile,
    [userId, isoYearsAgo(15), 'not_required'],
    'minor_requires_guardian_state',
  )

  await mustAccept('an adult may be stored at not_required', insertProfile, [
    userId,
    isoYearsAgo(30),
    'not_required',
  ])

  console.log('\n  Guardian relationship integrity\n')

  const insertRel = `
    insert into guardian_relationships
      (provider_user_id, invitation_email, state, consented_at, guardian_user_id, invitation_expires_at)
    values ($1, 'g@example.invalid', $2, $3, $4, $5)`

  await client.query(insertProfile, [userId, isoYearsAgo(15), 'required_uninvited'])

  await mustReject(
    'a verified relationship without consent is rejected',
    insertRel,
    [userId, 'verified', null, null, null],
    'verified_requires_consent',
  )

  await mustReject(
    'an invitation without an expiry is rejected',
    insertRel,
    [userId, 'invited', null, null, null],
    'pending_invitation_has_expiry',
  )

  await mustAccept('a well-formed invitation is accepted', insertRel, [
    userId,
    'invited',
    null,
    null,
    new Date(Date.now() + 864e5).toISOString(),
  ])

  await client.query('rollback')
  await client.end()

  console.log(`\n  ${passed} passed, ${failed} failed\n`)
  process.exit(failed === 0 ? 0 : 1)
}

function isoYearsAgo(years) {
  const d = new Date()
  d.setUTCFullYear(d.getUTCFullYear() - years)
  // Step one day past the birthday so "exactly N today" is unambiguous.
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

main().catch(async (err) => {
  console.error('\n  ' + (err.stack ?? String(err)) + '\n')
  try {
    await client.query('rollback')
    await client.end()
  } catch {}
  process.exit(1)
})
