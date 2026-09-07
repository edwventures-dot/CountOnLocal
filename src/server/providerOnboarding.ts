/**
 * POST /v1/provider/onboarding/start  (API_CONTRACT, Auth / onboarding)
 *
 * Creates the provider profile.
 *
 * ## The date of birth is gone, and that is the point
 *
 * This used to take a birth date, derive an age band from it, refuse
 * under-13s, and write a guardian state the server chose rather than the
 * client. All of that existed to place somebody in one of three bands.
 * There is one band now.
 *
 * Replacing it with a stored birth date nobody reads would be the worst of
 * both: FTC guidance says an operator that asks for and receives a date of
 * birth showing a user is under 13 has actual knowledge for COPPA
 * purposes, so collecting it on a public site creates an obligation that
 * not collecting it does not. The full product carried exactly that gap --
 * an under-13 signup was refused, but only after an account already
 * existed holding their email, and nothing deleted it.
 *
 * So the age question is answered by an attestation recorded as a consent
 * record (see domain/consent.ts, PROVIDER_ATTESTATION) and this never
 * learns a birth date at all. The refusal path and its audit action go
 * with it: there is nothing to refuse when nothing is asked.
 */

import { z } from 'zod'
import { writeAudit } from '@/server/audit'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'

export const onboardingStartSchema = z.object({
  countryCode: z.string().length(2).default('US'),
  displayFirstName: z.string().trim().min(1).max(60),
})

export type OnboardingStartInput = z.infer<typeof onboardingStartSchema>

export type OnboardingStartResult =
  | { ok: true; nextStage: 'ready' }
  | { ok: false; code: 'ALREADY_ONBOARDED' | 'WRITE_FAILED' }

/**
 * Creates the provider profile and grants the provider role.
 *
 * `db` must be the PRIVILEGED client. Row level security grants no client
 * write on provider_profiles or user_roles, deliberately: a client-side
 * insert would let the caller choose their own guardian_state, which is
 * precisely the tampering QA_ACCEPTANCE section 3 forbids. Instead the
 * server derives guardian_state from the date of birth and writes it.
 *
 * Authorization is therefore the caller's responsibility. The route
 * authenticates first and passes the session's user id -- never an id from
 * the request body.
 */
export async function startProviderOnboarding(args: {
  db: SupabaseClient<Database>
  userId: string
  input: OnboardingStartInput
  now: Date
  ip?: string | null
}): Promise<OnboardingStartResult> {
  const { db, userId, input, now } = args

  const { error: profileError } = await db.from('provider_profiles').insert({
    user_id: userId,
    country_code: input.countryCode,
    display_first_name: input.displayFirstName,
  })

  if (profileError) {
    // 23505 is unique_violation: a profile already exists for this user.
    if (profileError.code === '23505') return { ok: false, code: 'ALREADY_ONBOARDED' }
    console.error('[onboarding] provider_profiles insert failed', profileError.message)
    return { ok: false, code: 'WRITE_FAILED' }
  }

  const { error: roleError } = await db
    .from('user_roles')
    .insert({ user_id: userId, role: 'provider' })
  if (roleError && roleError.code !== '23505') {
    console.error('[onboarding] role grant failed', roleError.message)
    return { ok: false, code: 'WRITE_FAILED' }
  }

  // CLAUDE.md rule 9 lists role changes among the actions that must be
  // audited, and nothing wrote one. 23505 means the role was already held,
  // which is not a change and does not get a row.
  if (!roleError) {
    await writeAudit({
      actorUserId: userId,
      actorRole: 'provider',
      action: 'role.granted',
      targetType: 'user',
      targetId: userId,
      after: { role: 'provider', via: 'provider_onboarding' },
    })
  }

  await writeAudit({
    actorUserId: userId,
    actorRole: 'provider',
    action: 'provider.onboarding_started',
    targetType: 'provider_profile',
    targetId: userId,
    after: { country_code: input.countryCode },
    ip: args.ip ?? null,
  })

  return { ok: true, nextStage: 'ready' }
}
