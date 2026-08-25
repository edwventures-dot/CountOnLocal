/**
 * Migration runner.
 *
 * Applies every .sql file in migrations/ in filename order, once each,
 * recording what ran in schema_migrations. Each file runs inside a single
 * transaction, so a failure halfway through a migration leaves nothing
 * behind rather than a half-created schema someone has to unpick by hand.
 *
 *   node --env-file=.env.local scripts/migrate.mjs           apply pending
 *   node --env-file=.env.local scripts/migrate.mjs --status  list state
 *
 * Reads DATABASE_URL from .env.local. That string contains the database
 * password, so it lives only in that gitignored file.
 *
 * One constraint worth knowing: each file is sent as a single batch, and
 * Postgres parses every statement in a batch before executing any of them.
 * A file that creates an extension or type and then immediately declares a
 * column of that type fails at parse time. Give anything that introduces a
 * new type its own migration file.
 */

import { readdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import pg from 'pg'

const MIGRATIONS_DIR = path.join(process.cwd(), 'migrations')

function fail(message) {
  console.error(`\n  ${message}\n`)
  process.exit(1)
}

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  fail(
    'DATABASE_URL is not set.\n' +
      '  Add it to .env.local, then run with:\n' +
      '      node --env-file=.env.local scripts/migrate.mjs',
  )
}

async function loadMigrations() {
  const entries = await readdir(MIGRATIONS_DIR)
  const files = entries.filter((f) => f.endsWith('.sql')).sort()
  return Promise.all(
    files.map(async (name) => {
      const sql = await readFile(path.join(MIGRATIONS_DIR, name), 'utf8')
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex').slice(0, 16) }
    }),
  )
}

async function main() {
  const statusOnly = process.argv.includes('--status')
  const migrations = await loadMigrations()

  const client = new pg.Client({
    connectionString,
    // Supabase terminates TLS with its own CA; this is a direct admin
    // connection from a trusted machine, not user traffic.
    ssl: { rejectUnauthorized: false },
  })

  try {
    await client.connect()
  } catch (err) {
    fail(
      `Could not connect: ${err.message}\n` +
        '  If this is a network or IPv6 error, use the Session pooler\n' +
        '  connection string from Supabase instead of the direct one.',
    )
  }

  await client.query(`
    create table if not exists schema_migrations (
      name        text primary key,
      checksum    text not null,
      applied_at  timestamptz not null default now()
    )
  `)

  const { rows: applied } = await client.query('select name, checksum from schema_migrations')
  const appliedByName = new Map(applied.map((r) => [r.name, r.checksum]))

  if (statusOnly) {
    console.log('')
    for (const m of migrations) {
      const seen = appliedByName.get(m.name)
      if (!seen) console.log(`  PENDING   ${m.name}`)
      else if (seen !== m.checksum) console.log(`  CHANGED   ${m.name}  (applied version differs)`)
      else console.log(`  applied   ${m.name}`)
    }
    console.log('')
    await client.end()
    return
  }

  let ran = 0
  for (const m of migrations) {
    const seen = appliedByName.get(m.name)
    if (seen === m.checksum) continue
    if (seen && seen !== m.checksum) {
      await client.end()
      fail(
        `${m.name} was already applied but its contents changed.\n` +
          '  Editing an applied migration silently desyncs environments.\n' +
          '  Add a new migration instead.',
      )
    }

    process.stdout.write(`  applying ${m.name} ... `)
    try {
      await client.query('begin')
      await client.query(m.sql)
      await client.query('insert into schema_migrations (name, checksum) values ($1, $2)', [
        m.name,
        m.checksum,
      ])
      await client.query('commit')
      console.log('ok')
      ran += 1
    } catch (err) {
      await client.query('rollback')
      console.log('FAILED')
      await client.end()
      fail(`${m.name} failed and was rolled back:\n  ${err.message}`)
    }
  }

  console.log(ran === 0 ? '\n  Already up to date.\n' : `\n  Applied ${ran} migration(s).\n`)
  await client.end()
}

main().catch((err) => fail(err.stack ?? String(err)))
