/**
 * Loading the facts a provider gate needs.
 *
 * domain/gates.ts decides; this fetches. The two values that matter are the
 * authoritative date of birth and the stored guardian state, and both come
 * from provider_profiles rather than from anything a request could supply.
 * CLAUDE.md rule 2: guardian state is a real state machine, and the age it
 * is checked against is derived from the DOB every time rather than read
 * from a cached band that could be stale by a birthday.
 */

import { parsePlainDate, type PlainDate } from '@/domain/age'
import type { GuardianState } from '@/domain/guardian'
import type { ProviderGateContext } from '@/domain/gates'
import type { Role } from '@/domain/roles'
import { civilDateIn } from '@/server/occurrenceJobs'
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
  const { data: profile } = await args.db
    .from('provider_profiles')
    .select('date_of_birth, guardian_state')
    .eq('user_id', args.providerUserId)
    .maybeSingle()

  if (!profile) return null

  const today: PlainDate = civilDateIn(args.timezone ?? 'UTC', args.now)

  return {
    roles: args.roles,
    dateOfBirth: parsePlainDate(profile.date_of_birth),
    guardianState: profile.guardian_state as GuardianState,
    today,
  }
}
