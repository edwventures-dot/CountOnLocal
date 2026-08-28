/**
 * Providers turning eighteen.
 *
 * `AGED_OUT` existed on every state in the guardian machine and nothing
 * fired it, so a provider turned eighteen and stayed a supervised minor
 * indefinitely -- still gated on a guardian who no longer had any standing
 * to consent for them.
 *
 * ## The payout account is the hard part, not the state
 *
 * Clearing guardian state is one update. The money is not.
 *
 * A 13-17 provider's payouts go to a Stripe Connect account in the
 * GUARDIAN's name -- that is what the guardian agreed to: "I hold the
 * money until they turn 18." On the eighteenth birthday that sentence
 * expires, and there is no way to move a Connect account from one legal
 * person to another. The new adult has to onboard their own.
 *
 * So this job detaches the payout account rather than leaving it. The
 * alternatives were both worse:
 *
 *   - keep paying the guardian: money that now legally belongs to an adult
 *     keeps going to somebody else, on the strength of a consent that has
 *     expired;
 *   - do nothing and leave the state as-is: the provider stays gated on a
 *     guardian relationship that should no longer exist.
 *
 * Detaching means earnings keep accruing in the ledger -- nothing is lost
 * -- and stop being paid out until the provider connects their own
 * account. Customers are unaffected and keep being charged, because the
 * work is still happening.
 *
 * ## Which is why the warning matters more than the job
 *
 * Somebody who discovers this on their birthday has a broken payout and no
 * warning. So the job also notifies thirty days ahead, to both the
 * provider and the guardian, and again on the day. The notice is the
 * feature; the state change is the easy half.
 */

import { hasAgedOut, daysUntilEighteen, parsePlainDate } from '@/domain/age'
import { transition } from '@/domain/guardian'
import { enqueueNotification } from '@/server/notifications'
import { civilDateIn } from '@/server/occurrenceJobs'
import { writeAudit } from '@/server/audit'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'

type Db = SupabaseClient<Database>

/** How much notice somebody gets that their payout account is changing. */
export const AGE_OUT_WARNING_DAYS = 30

export type AgingRunResult = {
  considered: number
  agedOut: number
  warned: number
  failed: Array<{ providerUserId: string; message: string }>
}

export async function runAgeOut(args: { db: Db; now: Date }): Promise<AgingRunResult> {
  const result: AgingRunResult = { considered: 0, agedOut: 0, warned: 0, failed: [] }

  // Everybody still marked as needing a guardian. `not_required` is
  // already an adult and does not need looking at.
  const { data: profiles, error } = await args.db
    .from('provider_profiles')
    .select('user_id, date_of_birth, guardian_state, payout_account_user_id')
    .neq('guardian_state', 'not_required')

  if (error) {
    result.failed.push({ providerUserId: '*', message: error.message })
    return result
  }

  // UTC. A birthday is a civil date and the provider's own timezone would
  // be better, but a profile has no timezone -- the service does. Being at
  // most a day early or late on a notice is acceptable; being wrong about
  // whether somebody is an adult is not, and UTC is at worst a few hours
  // out either way.
  const today = civilDateIn('UTC', args.now)

  for (const profile of profiles ?? []) {
    result.considered += 1

    try {
      const dob = parsePlainDate(profile.date_of_birth)

      if (!hasAgedOut(dob, today)) {
        const days = daysUntilEighteen(dob, today)
        if (days === AGE_OUT_WARNING_DAYS) {
          await warn({ db: args.db, providerUserId: profile.user_id, days, now: args.now })
          result.warned += 1
        }
        continue
      }

      const moved = transition(profile.guardian_state as never, 'AGED_OUT')
      if (!moved.ok) {
        result.failed.push({
          providerUserId: profile.user_id,
          message: `cannot age out from ${profile.guardian_state}`,
        })
        continue
      }

      await args.db
        .from('provider_profiles')
        .update({
          guardian_state: moved.to,
          // Detached, not reassigned. See the header: a Connect account
          // belongs to a legal person and cannot be handed over.
          payout_account_user_id: null,
        })
        .eq('user_id', profile.user_id)
        .eq('guardian_state', profile.guardian_state)

      await args.db
        .from('guardian_relationships')
        .update({ state: moved.to })
        .eq('provider_user_id', profile.user_id)
        .not('state', 'in', '(revoked,expired)')

      await writeAudit({
        actorUserId: null,
        actorRole: 'system',
        action: 'guardian.aged_out',
        targetType: 'provider_profile',
        targetId: profile.user_id,
        before: { guardian_state: profile.guardian_state },
        after: {
          guardian_state: moved.to,
          payout_account_detached: profile.payout_account_user_id !== null,
        },
        reasonCode: 'turned_18',
      })

      await notifyAgedOut({
        db: args.db,
        providerUserId: profile.user_id,
        hadGuardianPayout: profile.payout_account_user_id !== null,
        now: args.now,
      })

      result.agedOut += 1
    } catch (err) {
      result.failed.push({
        providerUserId: profile.user_id,
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return result
}

/**
 * Thirty days' notice, to both parties.
 *
 * The guardian is told too, because they are the one whose account stops
 * receiving the money, and finding that out from a missing deposit is a
 * bad way to learn it.
 */
async function warn(args: {
  db: Db
  providerUserId: string
  days: number
  now: Date
}): Promise<void> {
  const recipients = await bothParties(args.db, args.providerUserId)

  for (const { userId, email, role } of recipients) {
    if (!email) continue
    await enqueueNotification({
      db: args.db,
      recipientUserId: userId,
      now: args.now,
      // One per person per birthday. A job that runs every four hours must
      // not send thirty copies.
      idempotencyKey: `age_out_warning:${args.providerUserId}:${userId}`,
      draft: {
        kind: 'guardian.aged_out',
        channel: 'email',
        destination: email,
        subject: 'A change is coming in 30 days',
        preview:
          role === 'guardian'
            ? 'The person you look after turns 18 next month, and payouts will stop coming to you.'
            : 'You turn 18 next month. You will need to set up your own payout account.',
        payload: { providerUserId: args.providerUserId, days: args.days },
      },
    })
  }
}

async function notifyAgedOut(args: {
  db: Db
  providerUserId: string
  hadGuardianPayout: boolean
  now: Date
}): Promise<void> {
  const recipients = await bothParties(args.db, args.providerUserId)

  for (const { userId, email, role } of recipients) {
    if (!email) continue
    await enqueueNotification({
      db: args.db,
      recipientUserId: userId,
      now: args.now,
      idempotencyKey: `aged_out:${args.providerUserId}:${userId}`,
      draft: {
        kind: 'guardian.aged_out',
        channel: 'email',
        destination: email,
        subject: role === 'guardian' ? 'They turned 18 today' : 'Happy birthday — one thing to do',
        preview:
          role === 'guardian'
            ? 'Your approval is no longer needed, and payouts have stopped coming to your account.'
            : args.hadGuardianPayout
              ? 'Your earnings are safe, but you need to set up your own payout account to receive them.'
              : 'Your account no longer needs a guardian.',
        payload: { providerUserId: args.providerUserId },
      },
    })
  }
}

async function bothParties(
  db: Db,
  providerUserId: string,
): Promise<Array<{ userId: string; email: string | null; role: 'provider' | 'guardian' }>> {
  const out: Array<{ userId: string; email: string | null; role: 'provider' | 'guardian' }> = []

  const { data: provider } = await db
    .from('users')
    .select('id, email')
    .eq('id', providerUserId)
    .maybeSingle()
  if (provider) out.push({ userId: provider.id, email: provider.email, role: 'provider' })

  const { data: rel } = await db
    .from('guardian_relationships')
    .select('guardian_user_id')
    .eq('provider_user_id', providerUserId)
    .not('state', 'in', '(revoked,expired)')
    .maybeSingle()

  if (rel?.guardian_user_id) {
    const { data: guardian } = await db
      .from('users')
      .select('id, email')
      .eq('id', rel.guardian_user_id)
      .maybeSingle()
    if (guardian) out.push({ userId: guardian.id, email: guardian.email, role: 'guardian' })
  }

  return out
}
