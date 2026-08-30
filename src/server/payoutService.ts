/**
 * Paying providers what they have earned.
 *
 * The ledger has recorded what each provider is owed since step 5 and
 * nothing ever moved it. This is the leg that does.
 *
 * ## "Immediate", honestly
 *
 * The owner's decision is immediate payout. What that means in practice is
 * "in the next job run", because this runs in the same daily pass as
 * settlement and directly after it -- a provider is paid within one run of
 * being credited.
 *
 * It is a separate step rather than part of settlement on purpose.
 * Settlement charges cards and can be declined; this moves money outward
 * and fails for entirely different reasons, most commonly a platform
 * balance that has not settled yet. Keeping them apart means one can
 * retry without re-running the other.
 *
 * ## Who the money goes to
 *
 * For a provider aged 13-17 it goes to the GUARDIAN's connected account,
 * which is what the guardian consented to. At eighteen the aging job
 * detaches that account, and payouts stop until the new adult connects
 * their own -- earnings keep accruing in the ledger meanwhile, so nothing
 * is lost, it just waits.
 *
 * ## Order of writes
 *
 * Transfer, then ledger. A ledger row for a transfer that did not happen
 * is worse than a transfer with no row: the first makes the books say a
 * provider was paid when they were not, and the second is visible in
 * Stripe and repaired by the next run. See planPayout for why the
 * idempotency key makes that retry safe.
 */

import { randomUUID } from 'node:crypto'
import {
  canReceivePayments,
  lifetimeEarnedCents,
  planPayout,
  NO_ACCOUNT,
  type StripeAccountState,
} from '@/domain/payout'
import { providerBalanceCents, type LedgerEntry } from '@/domain/ledger'
import { classifyAge, parsePlainDate } from '@/domain/age'
import { writeStandaloneEntries } from '@/server/ledgerWriter'
import { getCharger } from '@/server/charger'
import { civilDateIn } from '@/server/occurrenceJobs'
import { writeAudit } from '@/server/audit'
import { enqueueNotification } from '@/server/notifications'
import type { GuardianState } from '@/domain/guardian'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'

type Db = SupabaseClient<Database>

/**
 * Distinguishes one transfer attempt from the next.
 *
 * Only ever appended to the logical payout key, so it cannot affect which
 * payout a request is for -- it exists purely so Stripe treats a retry as
 * a new request rather than replaying a cached refusal.
 */
function attemptNonce(): string {
  return randomUUID().slice(0, 8)
}

export type PayoutRunResult = {
  considered: number
  paid: number
  paidCents: number
  /** Not failures. Held, not onboarded, nothing owed. */
  skipped: Record<string, number>
  failed: Array<{ providerUserId: string; message: string }>
}

export async function runPayouts(args: { db: Db; now: Date }): Promise<PayoutRunResult> {
  const result: PayoutRunResult = {
    considered: 0,
    paid: 0,
    paidCents: 0,
    skipped: {},
    failed: [],
  }

  const skip = (reason: string) => {
    result.skipped[reason] = (result.skipped[reason] ?? 0) + 1
  }

  // Providers who have been credited something. Everybody else has a zero
  // balance by definition and does not need looking at.
  const { data: earners, error } = await args.db
    .from('ledger_entries')
    .select('provider_user_id')
    .eq('kind', 'provider_earning')
    .not('provider_user_id', 'is', null)

  if (error) {
    result.failed.push({ providerUserId: '*', message: error.message })
    return result
  }

  const providerIds = [...new Set((earners ?? []).map((e) => e.provider_user_id as string))]
  const today = civilDateIn('UTC', args.now)

  for (const providerUserId of providerIds) {
    result.considered += 1

    try {
      const { data: entries } = await args.db
        .from('ledger_entries')
        .select('kind, amount_cents')
        .eq('provider_user_id', providerUserId)

      const ledger = (entries ?? []).map((e) => ({
        kind: e.kind,
        amountCents: e.amount_cents,
        currency: 'USD',
      })) as LedgerEntry[]

      const balanceCents = providerBalanceCents(ledger)
      const earnedCents = lifetimeEarnedCents(ledger)

      const { data: profile } = await args.db
        .from('provider_profiles')
        .select('date_of_birth, guardian_state, payout_account_user_id')
        .eq('user_id', providerUserId)
        .maybeSingle()

      if (!profile) {
        skip('NO_PROFILE')
        continue
      }

      const { data: hold } = await args.db
        .from('payout_holds')
        .select('id')
        .eq('provider_user_id', providerUserId)
        .is('released_at', null)
        .maybeSingle()

      const account = await accountStateOf(args.db, profile.payout_account_user_id)

      const plan = planPayout({
        providerUserId,
        balanceCents,
        lifetimeEarnedCents: earnedCents,
        held: Boolean(hold),
        gate: canReceivePayments({
          band: classifyAge(parsePlainDate(profile.date_of_birth), today),
          providerUserId,
          guardianUserId: profile.payout_account_user_id,
          guardianState: profile.guardian_state as GuardianState,
          account,
        }),
      })

      if (!plan.pay) {
        skip(plan.reason)
        continue
      }

      // Has this payout already gone out? Asked before every attempt.
      //
      // This is what replaced relying on Stripe's idempotency cache. That
      // cache stores failures too, for 24 hours, so a stable key turned one
      // transient refusal into a provider who could not be paid until they
      // happened to earn again -- verified against the live API, where the
      // same key replayed a stale balance_insufficient while the platform
      // balance was healthy.
      const existing = await getCharger().findTransfer({
        groupRef: plan.idempotencyKey,
        destinationRef: account.accountId!,
      })

      if (!existing.ok) {
        // An unanswerable question is not a no. Creating a transfer here
        // is how somebody gets paid twice.
        result.failed.push({ providerUserId, message: existing.message })
        continue
      }

      let externalId: string
      if (existing.externalId) {
        // A previous attempt moved the money and did not manage to write
        // the ledger row. Recover it rather than sending again.
        console.warn('[payout] recovering a transfer that was never recorded', {
          providerUserId,
          externalId: existing.externalId,
        })
        externalId = existing.externalId
      } else {
        const transfer = await getCharger().transfer({
          amountCents: plan.amountCents,
          currency: 'USD',
          destinationRef: account.accountId!,
          // Fresh per attempt, so a cached failure cannot outlive the
          // condition that caused it. Correctness comes from the lookup
          // above, not from this key.
          idempotencyKey: `${plan.idempotencyKey}:${attemptNonce()}`,
          groupRef: plan.idempotencyKey,
          description: 'Count On Local earnings',
        })

        if (!transfer.ok) {
          if (transfer.code === 'insufficient_funds') {
            // Normal: card payments take days to settle. Not a failure, and
            // the next run retries with a new key against the same group.
            skip('AWAITING_SETTLEMENT')
            continue
          }
          result.failed.push({ providerUserId, message: transfer.message })
          continue
        }
        externalId = transfer.externalId
      }

      // Positive: the platform's liability to this provider goes down.
      const written = await writeStandaloneEntries({
        db: args.db,
        entries: [
          {
            kind: 'payout',
            amountCents: plan.amountCents,
            currency: 'USD',
            providerUserId,
            idempotencyKey: plan.idempotencyKey,
            externalProcessor: 'stripe',
            externalId,
            memo: 'Earnings paid out',
          },
        ],
      })

      if (!written.ok) {
        // Money left and the books do not say so. Loud, and repaired by
        // the next run: the balance is unchanged, so the same key comes
        // back and Stripe returns this same transfer rather than a second.
        console.error('[payout] ledger write failed after transfer', {
          providerUserId,
          externalId,
          amountCents: plan.amountCents,
        })
        result.failed.push({ providerUserId, message: 'ledger write failed after transfer' })
        continue
      }

      await writeAudit({
        actorUserId: null,
        actorRole: 'system',
        action: 'payout.sent',
        targetType: 'user',
        targetId: providerUserId,
        after: {
          amount_cents: plan.amountCents,
          external_id: externalId,
          // Recorded because for a minor this is somebody else's account,
          // and a year from now that should not need reconstructing.
          holder_user_id: profile.payout_account_user_id,
        },
      })

      await notifyPaid({
        db: args.db,
        holderUserId: profile.payout_account_user_id,
        amountCents: plan.amountCents,
        now: args.now,
        idempotencyKey: plan.idempotencyKey,
      })

      result.paid += 1
      result.paidCents += plan.amountCents
    } catch (err) {
      result.failed.push({
        providerUserId,
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return result
}

async function accountStateOf(
  db: Db,
  holderUserId: string | null,
): Promise<StripeAccountState> {
  if (!holderUserId) return NO_ACCOUNT

  const { data: holder } = await db
    .from('users')
    .select(
      'stripe_connected_account_id, stripe_transfers_active, stripe_payouts_active, stripe_requirements_due',
    )
    .eq('id', holderUserId)
    .maybeSingle()

  if (!holder) return NO_ACCOUNT

  return {
    accountId: holder.stripe_connected_account_id,
    transfersActive: holder.stripe_transfers_active,
    payoutsActive: holder.stripe_payouts_active,
    requirementsDue: holder.stripe_requirements_due ?? [],
  }
}

/**
 * Tells whoever holds the account that money arrived.
 *
 * For a minor that is the guardian, which is the point: they agreed to
 * receive and oversee it, and overseeing something nobody told them about
 * is not possible.
 */
async function notifyPaid(args: {
  db: Db
  holderUserId: string | null
  amountCents: number
  now: Date
  idempotencyKey: string
}): Promise<void> {
  if (!args.holderUserId) return

  const { data: holder } = await args.db
    .from('users')
    .select('email')
    .eq('id', args.holderUserId)
    .maybeSingle()

  if (!holder?.email) return

  await enqueueNotification({
    db: args.db,
    recipientUserId: args.holderUserId,
    now: args.now,
    idempotencyKey: `notify_${args.idempotencyKey}`,
    draft: {
      kind: 'payout.sent',
      channel: 'email',
      destination: holder.email,
      subject: 'Earnings are on the way',
      // The amount is fine to say; it is the recipient's own money and
      // says nothing about a customer or an address.
      preview: `$${(args.amountCents / 100).toFixed(2)} has been sent to your payout account.`,
      payload: { amountCents: args.amountCents },
    },
  })
}
