/**
 * Loading the facts a provider gate needs.
 *
 * domain/gates.ts decides; this fetches. There is very little left to
 * fetch: the gate used to need an authoritative date of birth and a stored
 * guardian state, and now it needs to know only that a provider profile
 * exists at all. Kept as its own function anyway, because the seam between
 * "what is true" and "what that means" is the thing that made these
 * decisions testable, and collapsing it would be a step backwards for the
 * sake of four lines.
 */

import type { ProviderGateContext } from '@/domain/gates'
import type { Role } from '@/domain/roles'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'

type Db = SupabaseClient<Database>

/**
 * Builds the gate context, or null when the caller has no provider profile
 * at all -- which is not a denial, it is a different answer: they are not a
 * provider and never were.
 */
export async function loadProviderGateContext(args: {
  db: Db
  providerUserId: string
  roles: readonly Role[]
  now: Date
  /** Zone the calendar date is resolved in. UTC unless a route supplies one. */
  timezone?: string | undefined
}): Promise<ProviderGateContext | null> {
  // Only that a profile exists. The gate used to need a date of birth and
  // a guardian state; with every provider an adult it needs neither, and
  // reading a birth date to then ignore it would be collecting something
  // for nothing.
  const { data: profile } = await args.db
    .from('provider_profiles')
    .select('user_id')
    .eq('user_id', args.providerUserId)
    .maybeSingle()

  if (!profile) return null

  return { roles: args.roles }
}
