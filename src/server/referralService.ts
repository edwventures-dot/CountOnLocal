/**
 * Referrals: attaching a code, spending the discount, paying the bonus.
 *
 * The policy lives in domain/referral.ts and the entries in domain/ledger.ts.
 * This is the part that touches the database, in an order chosen so every
 * way it can fail leaves something recoverable.
 *
 * ## A bad code never fails a checkout
 *
 * `attachReferral` reports why a code was not applied and returns; it does
 * not abort the subscription. A customer who mistyped one character of an
 * eight-character code has still decided to buy, and losing that sale to
 * punish a typo would be a worse outcome for everybody including the
 * provider whose code it was. The caller surfaces the reason so the
 * customer is told rather than silently charged full price -- silence is
 * the failure that actually matters here, not the missing discount.
 *
 * ## Two different idempotency mechanisms, on purpose
 *
 * The discount is guarded by `referrals.discount_applied_cents`: it is NULL
 * until spent, and settlement checks it before discounting. The bonus is
 * guarded by a ledger idempotency key. Neither is arbitrary -- the discount
 * has no ledger row of its own (it is a smaller charge, not a movement), so
 * it needs a marker on the referral; the bonus is a movement, so the
 * ledger's own unique index is the stronger guard and no marker would beat
 * it.
 *
 * ## Qualification is a job, not a hook on completion
 *
 * Paying the bonus the instant an occurrence completes would put a money
 * movement on the provider's completion tap. It also could not answer
 * "was the cycle actually charged" without a ledger read that the
 * completion path has no other reason to do. Running it in the daily job
 * keeps the completion route thin and lets qualification read the ledger,
 * which is the only honest source for whether money moved.
 */

import {
  DEFAULT_REFERRAL_TERMS,
  discountQuote,
  referralQualifies,
  type ReferralTerms,
} from '@/domain/referral'
import { referralBonusEntries } from '@/domain/ledger'
import { normalizeReferralCode } from '@/domain/density'
import type { CycleQuote } from '@/domain/money'
import { writeBalancedEntries } from '@/server/ledgerWriter'
import { writeAudit } from '@/server/audit'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'

type Db = SupabaseClient<Database>

export type AttachOutcome =
  | { applied: true; referralId: string; providerUserId: string }
  | {
      applied: false
      reason: 'UNKNOWN_CODE' | 'REVOKED_CODE' | 'SELF_REFERRAL' | 'ALREADY_REFERRED' | 'WRITE_FAILED'
    }

/**
 * Records that a subscription came from a referral code.
 *
 * Nothing financial happens here. The discount is not applied until the
 * first charge, and the bonus not until work is delivered, so a checkout
 * that is abandoned before payment leaves a pending row that never costs
 * anybody anything.
 */
export async function attachReferral(args: {
  db: Db
  subscriptionId: string
  customerUserId: string
  code: string
  terms?: ReferralTerms | undefined
}): Promise<AttachOutcome> {
  const terms = args.terms ?? DEFAULT_REFERRAL_TERMS
  // Codes are read aloud across a fence and typed off a flyer, so case,
  // spaces and a dash somebody added for readability are not the
  // customer's mistake to pay for. normalizeReferralCode already knows the
  // alphabet, including which characters were deliberately excluded.
  const code = normalizeReferralCode(args.code)
  if (code.length === 0) return { applied: false, reason: 'UNKNOWN_CODE' }

  const { data: row } = await args.db
    .from('referral_codes')
    .select('code, provider_user_id, revoked_at')
    .eq('code', code)
    .maybeSingle()

  if (!row) return { applied: false, reason: 'UNKNOWN_CODE' }
  if (row.revoked_at !== null) return { applied: false, reason: 'REVOKED_CODE' }

  // Also a table constraint. Checked here so the customer gets a reason
  // rather than a write error, and there so it stays true whatever calls
  // the database next.
  if (row.provider_user_id === args.customerUserId) {
    return { applied: false, reason: 'SELF_REFERRAL' }
  }

  const { data: inserted, error } = await args.db
    .from('referrals')
    .insert({
      subscription_id: args.subscriptionId,
      code: row.code,
      provider_user_id: row.provider_user_id,
      customer_user_id: args.customerUserId,
      customer_discount_bps: terms.customerDiscountBps,
      provider_bonus_cents: terms.providerBonusCents,
    })
    .select('id')
    .single()

  if (error || !inserted) {
    // 23505 is the one-referral-per-subscription index. Not an error worth
    // shouting about: it means this subscription already has a referral.
    if (error?.code === '23505') return { applied: false, reason: 'ALREADY_REFERRED' }
    console.error('[referral] attach failed', error?.message)
    return { applied: false, reason: 'WRITE_FAILED' }
  }

  return { applied: true, referralId: inserted.id, providerUserId: row.provider_user_id }
}

export type PendingDiscount = {
  referralId: string
  terms: ReferralTerms
}

/**
 * The unspent discount on a subscription, if there is one.
 *
 * Voided referrals are excluded. A referral voided for abuse must not still
 * be handing out a discount on the next cycle.
 */
export async function unspentDiscountFor(args: {
  db: Db
  subscriptionId: string
}): Promise<PendingDiscount | null> {
  const { data } = await args.db
    .from('referrals')
    .select('id, customer_discount_bps, provider_bonus_cents, discount_applied_cents, state')
    .eq('subscription_id', args.subscriptionId)
    .is('discount_applied_cents', null)
    .neq('state', 'void')
    .maybeSingle()

  if (!data) return null

  return {
    referralId: data.id,
    terms: {
      customerDiscountBps: data.customer_discount_bps,
      providerBonusCents: data.provider_bonus_cents,
    },
  }
}

export type DiscountApplication = {
  quote: CycleQuote
  discountCents: number
  referralId: string
}

/**
 * Prices a cycle with any unspent referral discount applied.
 *
 * Returns the quote unchanged, and no referral id, when there is nothing to
 * apply -- so a caller can use the result unconditionally.
 */
export async function quoteWithReferral(args: {
  db: Db
  subscriptionId: string
  quote: CycleQuote
}): Promise<DiscountApplication | { quote: CycleQuote; discountCents: 0; referralId: null }> {
  const pending = await unspentDiscountFor({ db: args.db, subscriptionId: args.subscriptionId })
  if (!pending) return { quote: args.quote, discountCents: 0, referralId: null }

  const { quote, discountCents } = discountQuote({ quote: args.quote, terms: pending.terms })
  if (discountCents === 0) return { quote: args.quote, discountCents: 0, referralId: null }

  return { quote, discountCents, referralId: pending.referralId }
}

/**
 * Marks a discount spent.
 *
 * Conditional on it still being unspent, so two settlements racing on the
 * same subscription cannot both claim it: one update matches, the other
 * matches nothing. Same trick the notification outbox uses to claim a row.
 *
 * Called after the charge, not before. A discount marked spent on a charge
 * that then failed would silently cost the customer their reward.
 */
export async function markDiscountSpent(args: {
  db: Db
  referralId: string
  discountCents: number
  now: Date
}): Promise<boolean> {
  const { data } = await args.db
    .from('referrals')
    .update({
      discount_applied_cents: args.discountCents,
      discount_applied_at: args.now.toISOString(),
    })
    .eq('id', args.referralId)
    .is('discount_applied_cents', null)
    .select('id')

  return (data ?? []).length === 1
}

export type RewardRunResult = {
  considered: number
  qualified: number
  paid: number
  voided: number
  failed: Array<{ referralId: string; message: string }>
}

/**
 * Qualifies pending referrals and pays the bonuses they have earned.
 *
 * Two steps in one pass, because the second is only ever reached through
 * the first and splitting them would mean a referral waits a whole cron
 * cycle between earning a bonus and being paid it.
 */
export async function runReferralRewards(args: { db: Db; now: Date }): Promise<RewardRunResult> {
  const result: RewardRunResult = {
    considered: 0,
    qualified: 0,
    paid: 0,
    voided: 0,
    failed: [],
  }

  const { data: rows } = await args.db
    .from('referrals')
    .select('id, subscription_id, provider_user_id, provider_bonus_cents, state, qualified_at')
    .in('state', ['pending', 'qualified'])

  for (const referral of rows ?? []) {
    result.considered += 1

    try {
      let qualifiedAt = referral.qualified_at

      if (referral.state === 'pending') {
        const outcome = await evaluate({ db: args.db, subscriptionId: referral.subscription_id })

        if (outcome === 'void') {
          await args.db
            .from('referrals')
            .update({
              state: 'void',
              voided_at: args.now.toISOString(),
              void_reason: 'subscription ended before a visit was delivered',
            })
            .eq('id', referral.id)
            .eq('state', 'pending')

          await writeAudit({
            actorUserId: null,
            actorRole: 'system',
            action: 'referral.voided',
            targetType: 'referral',
            targetId: referral.id,
            after: { reason: 'subscription ended before a visit was delivered' },
            reasonCode: 'never_qualified',
          })

          result.voided += 1
          continue
        }

        if (outcome === 'wait') continue

        const { data: moved } = await args.db
          .from('referrals')
          .update({ state: 'qualified', qualified_at: args.now.toISOString() })
          .eq('id', referral.id)
          .eq('state', 'pending')
          .select('id')

        // Somebody else qualified it in this same run. Theirs will pay it.
        if ((moved ?? []).length !== 1) continue

        qualifiedAt = args.now.toISOString()
        result.qualified += 1
      }

      if (referral.provider_bonus_cents === 0) {
        await args.db
          .from('referrals')
          .update({ state: 'paid', paid_at: args.now.toISOString() })
          .eq('id', referral.id)
        result.paid += 1
        continue
      }

      const entries = referralBonusEntries({
        bonusCents: referral.provider_bonus_cents,
        providerUserId: referral.provider_user_id,
        referralId: referral.id,
      })

      // Ledger before state, deliberately, and the opposite way round from
      // settlement. Settlement charges a card it cannot un-charge, so it
      // writes after. Here both sides are ours: a crash between the two
      // leaves a paid bonus on a still-qualified referral, which the next
      // run retries and the idempotency key refuses. State first would
      // leave a referral marked paid that never was, which nothing detects.
      // Balanced, not standalone: the pair sums to zero, and using the
      // checking writer means a future edit that breaks that is refused
      // rather than written.
      const written = await writeBalancedEntries({ db: args.db, entries })

      // A duplicate comes back ok -- the unique index already refused it,
      // which is a previous run's success, not this run's failure.
      if (!written.ok) {
        result.failed.push({ referralId: referral.id, message: written.message })
        continue
      }

      await args.db
        .from('referrals')
        .update({
          state: 'paid',
          paid_at: args.now.toISOString(),
          ...(qualifiedAt ? { qualified_at: qualifiedAt } : {}),
        })
        .eq('id', referral.id)

      await writeAudit({
        actorUserId: null,
        actorRole: 'system',
        action: 'referral.bonus_paid',
        targetType: 'referral',
        targetId: referral.id,
        after: {
          provider_user_id: referral.provider_user_id,
          bonus_cents: referral.provider_bonus_cents,
        },
      })

      result.paid += 1
    } catch (error) {
      result.failed.push({
        referralId: referral.id,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return result
}

/**
 * Has this referral's subscription earned the reward, failed to, or not yet?
 *
 * "Charged" is read from the ledger rather than from the subscription's
 * state, because the ledger is the only record that says money actually
 * moved. "Delivered" counts occurrences the provider marked done.
 */
async function evaluate(args: {
  db: Db
  subscriptionId: string
}): Promise<'qualify' | 'wait' | 'void'> {
  const { data: charges } = await args.db
    .from('ledger_entries')
    .select('id')
    .eq('subscription_id', args.subscriptionId)
    .eq('kind', 'customer_charge')
    .limit(1)

  const { data: delivered } = await args.db
    .from('service_occurrences')
    .select('id')
    .eq('subscription_id', args.subscriptionId)
    .in('state', ['completed', 'settled'])
    .limit(1)

  if (
    referralQualifies({
      cycleWasCharged: (charges ?? []).length > 0,
      deliveredOccurrences: (delivered ?? []).length,
    })
  ) {
    return 'qualify'
  }

  // Not qualified. Is it still able to become so?
  const { data: sub } = await args.db
    .from('subscriptions')
    .select('state')
    .eq('id', args.subscriptionId)
    .maybeSingle()

  // A cancelled subscription with no delivered visit never will. Leaving it
  // pending forever would make the job re-read it every four hours for the
  // life of the platform.
  if (!sub || sub.state === 'canceled') return 'void'

  return 'wait'
}
