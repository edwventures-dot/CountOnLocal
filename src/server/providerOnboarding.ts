/**
 * POST /v1/provider/onboarding/start  (API_CONTRACT, Auth / onboarding)
 *
 * "Creates provider profile and age state."
 */

import { z } from 'zod'
import { parsePlainDate, decideProviderAge, type PlainDate } from '@/domain/age'
import { initialGuardianState } from '@/domain/guardian'
import { writeAudit } from '@/server/audit'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'

export const onboardingStartSchema = z.object({
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
  countryCode: z.string().length(2).default('US'),
  displayFirstName: z.string().trim().min(1).max(60),
})

export type OnboardingStartInput = z.infer<typeof onboardingStartSchema>

export type OnboardingStartResult =
  | { ok: true; nextStage: 'guardian_invitation' | 'payout_onboarding'; guardianRequired: boolean }
  | { ok: false; code: 'PROVIDER_INELIGIBLE' | 'ALREADY_ONBOARDED' | 'WRITE_FAILED' }

export function todayUtc(now: Date): PlainDate {
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, day: now.getUTCDate() }
}

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

  const dob = parsePlainDate(input.dateOfBirth)
  const decision = decideProviderAge(dob, todayUtc(now))

  if (!decision.allowed) {
    // Recorded so a pattern of repeated attempts from one account is
    // visible to trust and safety. The DOB itself is redacted by
    // writeAudit, so the log shows that a refusal happened without
    // retaining the minor's birth date in a second place.
    await writeAudit({
      actorUserId: userId,
      actorRole: 'provider',
      action: 'provider.registration_refused',
      targetType: 'user',
      targetId: userId,
      reasonCode: 'PROVIDER_INELIGIBLE',
      ip: args.ip ?? null,
    })
    return { ok: false, code: 'PROVIDER_INELIGIBLE' }
  }

  const guardianState = initialGuardianState(decision.band)

  const { error: profileError } = await db.from('provider_profiles').insert({
    user_id: userId,
    date_of_birth: input.dateOfBirth,
    country_code: input.countryCode,
    display_first_name: input.displayFirstName,
    guardian_state: guardianState,
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

  await writeAudit({
    actorUserId: userId,
    actorRole: 'provider',
    action: 'provider.onboarding_started',
    targetType: 'provider_profile',
    targetId: userId,
    after: { guardian_state: guardianState, country_code: input.countryCode },
    ip: args.ip ?? null,
  })

  return {
    ok: true,
    guardianRequired: decision.guardianRequired,
    nextStage: decision.guardianRequired ? 'guardian_invitation' : 'payout_onboarding',
  }
}
