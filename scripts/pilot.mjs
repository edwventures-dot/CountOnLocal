/**
 * The pilot list, from the command line.
 *
 * A neighbourhood pilot is fifteen people the owner knows by name. That
 * does not need an admin screen, and building one would be the larger
 * mistake -- a console nobody opens is how the undelivered-mail table sat
 * unread for weeks.
 *
 *   npm run pilot -- status
 *   npm run pilot -- on
 *   npm run pilot -- off
 *   npm run pilot -- add neighbour@example.org "Sarah, two doors down"
 *   npm run pilot -- remove neighbour@example.org
 *   npm run pilot -- list
 *
 * Turning the pilot ON restricts signup to this list. Turning it OFF lets
 * anyone with the URL create an account, so it is the pre-launch gate in
 * src/lib/prelaunch.ts that should stay up until a market is genuinely
 * open.
 */

import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.')
  process.exit(1)
}

const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
const [command, ...rest] = process.argv.slice(2)

async function flag() {
  const { data } = await db
    .from('platform_settings')
    .select('value')
    .eq('key', 'pilot_invite_only')
    .maybeSingle()
  return data?.value === 'on'
}

async function setFlag(value) {
  const { error } = await db
    .from('platform_settings')
    .update({ value, updated_at: new Date().toISOString() })
    .eq('key', 'pilot_invite_only')
  if (error) throw new Error(error.message)
}

async function list() {
  const { data, error } = await db
    .from('pilot_invites')
    .select('email, note, invited_at, redeemed_at')
    .order('invited_at', { ascending: true })
  if (error) throw new Error(error.message)
  return data ?? []
}

function usage() {
  console.log('  npm run pilot -- status | on | off | list')
  console.log('  npm run pilot -- add <email> ["note"]')
  console.log('  npm run pilot -- remove <email>')
}

try {
  switch (command) {
    case 'status': {
      const on = await flag()
      const rows = await list()
      const joined = rows.filter((r) => r.redeemed_at).length
      console.log(`\n  invite-only signup:  ${on ? 'ON' : 'off'}`)
      console.log(`  invited:             ${rows.length}`)
      console.log(`  joined:              ${joined}\n`)
      if (!on && rows.length > 0) {
        console.log('  Note: addresses are listed but the gate is off, so anyone can sign up.\n')
      }
      break
    }

    case 'on':
    case 'off': {
      await setFlag(command)
      console.log(`\n  invite-only signup is now ${command.toUpperCase()}.\n`)
      if (command === 'off') {
        console.log('  Anyone who can reach the site can now create an account.\n')
      }
      break
    }

    case 'add': {
      const [email, note] = rest
      if (!email) {
        usage()
        break
      }
      const { error } = await db
        .from('pilot_invites')
        .upsert({ email: email.trim().toLowerCase(), note: note ?? null }, { onConflict: 'email' })
      if (error) throw new Error(error.message)
      console.log(`\n  invited ${email.trim().toLowerCase()}\n`)
      break
    }

    case 'remove': {
      const [email] = rest
      if (!email) {
        usage()
        break
      }
      // Removing does not delete an account that already exists. The list
      // controls who may join, not who stays.
      const { error } = await db
        .from('pilot_invites')
        .delete()
        .eq('email', email.trim().toLowerCase())
      if (error) throw new Error(error.message)
      console.log(`\n  removed ${email.trim().toLowerCase()} from the invite list.`)
      console.log('  Any account they already created still exists.\n')
      break
    }

    case 'list': {
      const rows = await list()
      if (rows.length === 0) {
        console.log('\n  Nobody invited yet.\n')
        break
      }
      console.log('')
      for (const r of rows) {
        const state = r.redeemed_at ? 'joined ' : 'invited'
        console.log(`  ${state}  ${r.email}${r.note ? `  — ${r.note}` : ''}`)
      }
      console.log('')
      break
    }

    default:
      usage()
  }
} catch (err) {
  console.error(`\n  ${err.message}\n`)
  process.exit(1)
}
