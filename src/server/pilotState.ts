/**
 * Whether an invited pilot is currently running.
 *
 * One source of truth: `platform_settings.pilot_invite_only`, the same row
 * the database trigger in migration 0043 reads when it decides whether to
 * refuse a signup. Nothing here keeps its own copy in an environment
 * variable, because the failure mode of two copies is precisely the bug
 * this was written to fix -- a legal page saying "no one can sign up yet"
 * while neighbours are signing up.
 *
 * Fails closed toward the quieter statement. If the setting cannot be read,
 * the pages say the pre-launch wording, which is the more conservative
 * claim: it promises less about who is using the product. A banner that
 * under-claims during an outage is a smaller problem than one that
 * announces a pilot that is not running.
 *
 * ## Read with the user-scoped client, not the admin one
 *
 * The legal pages are public and unauthenticated -- they are three of the
 * five paths the pre-launch gate lets through. Instantiating a service-role
 * client on a path a stranger can hit is more privilege than the question
 * needs, and the question needs none: migration 0040 grants anon SELECT on
 * platform_settings with a `using (true)` policy, because a posture flag is
 * not a secret. So this reads it as anybody would.
 */

import { createSupabaseServerClient } from '@/lib/supabase/server'

export async function pilotRunning(): Promise<boolean> {
  try {
    const db = await createSupabaseServerClient()
    const { data, error } = await db
      .from('platform_settings')
      .select('value')
      .eq('key', 'pilot_invite_only')
      .maybeSingle()

    if (error) {
      console.error('[pilot] could not read pilot_invite_only', error.message)
      return false
    }

    return data?.value === 'on'
  } catch (err) {
    console.error('[pilot] could not read pilot_invite_only', (err as Error).message)
    return false
  }
}
