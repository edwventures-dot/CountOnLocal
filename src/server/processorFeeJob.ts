/**
 * Recording what the payment processor actually took.
 *
 * The ledger has always been able to say what the customer paid, what the
 * provider is owed and what fee we quoted. It has never been able to say
 * what Stripe kept, because there was no kind for it and nothing asked.
 *
 * So every charge posted customer_charge, provider_earning and platform_fee,
 * summed to zero, and looked complete -- while the platform's real share was
 * smaller than the platform_fee row by whatever Stripe deducted.
 * `platformRevenueCents` summed platform_fee and returned it as "revenue
 * recognised". Every number the platform had about its own income was gross
 * wearing the label of net, and nothing in the system disagreed, because
 * the missing rows were missing rather than wrong.
 *
 * ## Why a job and not the charge path
 *
 * The fee is not known when the money moves. It lives on the balance
 * transaction, which Stripe creates when the charge settles -- usually
 * quickly, not always immediately. Fetching it inside `charge()` would put
 * a second network call and a second failure mode between a customer and
 * their subscription, in exchange for a number nobody at the keyboard is
 * waiting for.
 *
 * Reconciling afterwards also means this backfills rather than only fixing
 * the books going forward: any charge already in the table gets its fee the
 * first time this runs. The table happened to be empty when this was
 * written -- the test buyers had been cleaned up -- so that path is proven
 * by the integration test rather than by production data.
 *
 * ## Pending is not zero
 *
 * A charge whose balance transaction has not appeared yet is left alone and
 * retried. Writing a zero fee would be a lie that never corrects itself:
 * the idempotency key would be taken, the row would say Stripe charged us
 * nothing, and no later run would revisit it.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'
import { processorFeeEntries, processorFeeKey } from '@/domain/ledger'
import { writeBalancedEntries } from './ledgerWriter'
import { getCharger } from './charger'

type Db = SupabaseClient<Database>

export type ProcessorFeeRunResult = {
  /** Charges considered this run. */
  examined: number
  /** Fee pairs written. */
  recorded: number
  /** Charges whose fee the processor has not settled yet. Retried later. */
  pending: number
  /** Already had a fee row. Cheap, and proves idempotency in production. */
  alreadyRecorded: number
  /** Charges the processor could not answer for. Left for the next run. */
  failed: number
  feesRecordedCents: number
  errors: string[]
}

/**
 * How many charges to reconcile in one run.
 *
 * Each one is a Stripe API call, so an unbounded run against a large
 * backlog would be a long serial crawl that rate-limits itself. The job is
 * safe to run repeatedly, so a backlog drains over several runs rather than
 * in one that might time out halfway and leave no record of how far it got.
 */
const BATCH = 200

/**
 * Finds charges with no processor fee recorded and records it.
 *
 * Safe to run at any frequency: every write is keyed on the processor's own
 * charge id, so a second run over the same charge is refused by the unique
 * index rather than doubling anything.
 */
export async function runProcessorFeeReconciliation(args: {
  db: Db
  limit?: number
}): Promise<ProcessorFeeRunResult> {
  const { db } = args
  const result: ProcessorFeeRunResult = {
    examined: 0,
    recorded: 0,
    pending: 0,
    alreadyRecorded: 0,
    failed: 0,
    feesRecordedCents: 0,
    errors: [],
  }

  // Charges carry the processor's id; everything else in a charge set does
  // not need to be looked at.
  const { data: charges, error } = await db
    .from('ledger_entries')
    .select('external_id, external_processor, currency, subscription_id, customer_user_id, provider_user_id')
    .eq('kind', 'customer_charge')
    .not('external_id', 'is', null)
    .order('created_at', { ascending: true })
    .limit(args.limit ?? BATCH)

  if (error) {
    console.error('[procfee] could not list charges', error.message)
    result.errors.push(error.message)
    return result
  }

  if (!charges || charges.length === 0) return result

  // One query for what is already recorded, rather than one per charge.
  const keys = charges
    .map((c) => (c.external_id ? processorFeeKey({ externalId: c.external_id }) : null))
    .filter((k): k is string => k !== null)

  const { data: existing, error: existingError } = await db
    .from('ledger_entries')
    .select('idempotency_key')
    .in('idempotency_key', keys)

  if (existingError) {
    console.error('[procfee] could not check existing fees', existingError.message)
    result.errors.push(existingError.message)
    return result
  }

  const done = new Set((existing ?? []).map((r) => r.idempotency_key).filter(Boolean) as string[])
  const charger = getCharger()

  for (const charge of charges) {
    const externalId = charge.external_id
    if (!externalId) continue

    // A charge with no subscription cannot be attributed, and guessing
    // where a fee belongs is worse than leaving it visible as unreconciled.
    if (!charge.subscription_id) continue

    result.examined += 1

    const key = processorFeeKey({ externalId })
    if (done.has(key)) {
      result.alreadyRecorded += 1
      continue
    }

    const fee = await charger.chargeFee({ externalId })

    if (!fee.ok) {
      result.failed += 1
      result.errors.push(`${externalId}: ${fee.message}`)
      continue
    }

    if (fee.state === 'pending') {
      result.pending += 1
      continue
    }

    if (fee.currency !== charge.currency) {
      // Single currency in V1. A mismatch means an assumption broke, and
      // converting one here would be inventing a rate.
      result.failed += 1
      result.errors.push(
        `${externalId}: fee currency ${fee.currency} does not match charge currency ${charge.currency}`,
      )
      continue
    }

    // A genuinely free charge is possible and needs no rows.
    if (fee.feeCents === 0) {
      result.alreadyRecorded += 1
      continue
    }

    const entries = processorFeeEntries({
      feeCents: fee.feeCents,
      subscriptionId: charge.subscription_id,
      customerUserId: charge.customer_user_id ?? undefined,
      providerUserId: charge.provider_user_id ?? undefined,
      currency: charge.currency,
      externalProcessor: charge.external_processor ?? undefined,
      externalId,
      idempotencyKey: key,
    })

    const written = await writeBalancedEntries({ db, entries })

    if (!written.ok) {
      result.failed += 1
      result.errors.push(`${externalId}: ${written.message}`)
      continue
    }

    if (written.duplicate) {
      result.alreadyRecorded += 1
      continue
    }

    result.recorded += 1
    result.feesRecordedCents += fee.feeCents
  }

  return result
}
