/**
 * The money ledger.
 *
 * TECHNICAL_SPEC section 10 wants an append-only record of every movement,
 * in integer cents, each row pointing at its source entity and processor id.
 * Migration 0013 adds the sign rule: "a credit or refund is negative from
 * the platform's perspective, so a sum over a subscription is meaningful
 * without a per-kind sign lookup."
 *
 * This module turns that sentence into an enforced invariant.
 *
 * ## The convention, stated once
 *
 * Amounts are from the platform's point of view, and one charge decomposes
 * into exactly the pieces it is made of:
 *
 *     customer_charge   +1380   the customer paid this
 *     provider_earning  -1200   the platform now owes the provider this
 *     platform_fee       -180   the platform keeps this
 *     ------------------------
 *     sum                   0
 *
 * A subscription whose entries sum to zero is fully allocated: every cent
 * taken has been assigned to somebody. A non-zero sum is a bug, and because
 * the sum is cheap to compute it can be asserted in tests, in a reconciler,
 * and in an admin view.
 *
 * Payouts deliberately carry provider_user_id and no subscription_id. A
 * payout settles the accumulated provider_earning liability across many
 * subscriptions at once, so attaching it to one of them would break that
 * per-subscription zero. Provider balance is its own sum -- see
 * providerBalanceCents.
 *
 * ## Why not full double-entry
 *
 * A real two-sided system with a cash account and named ledgers would be
 * more rigorous and much heavier, and V1 has one platform, one processor
 * and one currency. This is the smallest thing that still makes
 * "did the money all get accounted for" a question with a definite answer.
 * If the finance side ever needs true accounts, this convention is the
 * thing to replace, not to extend.
 */

import { roundHalfUp } from './money'
import type { CycleQuote } from './money'

export type LedgerKind =
  | 'customer_charge'
  | 'platform_fee'
  | 'provider_earning'
  | 'credit'
  | 'refund'
  | 'dispute'
  | 'payout'
  | 'adjustment'

export type LedgerEntry = {
  kind: LedgerKind
  /** Signed, integer cents, platform perspective. */
  amountCents: number
  currency: string
  subscriptionId?: string | undefined
  occurrenceId?: string | undefined
  customerUserId?: string | undefined
  providerUserId?: string | undefined
  externalProcessor?: string | undefined
  externalId?: string | undefined
  /**
   * Unique per money-moving event. TECHNICAL_SPEC section 11: a replayed
   * webhook must not double-post. The column is UNIQUE, so a duplicate
   * insert fails loudly rather than quietly doubling a provider's earnings.
   */
  idempotencyKey?: string | undefined
  memo?: string | undefined
}

export function sumCents(entries: readonly LedgerEntry[]): number {
  return entries.reduce((acc, e) => acc + e.amountCents, 0)
}

/** True when every cent taken has been assigned. See the header. */
export function isBalanced(entries: readonly LedgerEntry[]): boolean {
  return sumCents(entries) === 0
}

function assertWholeCents(label: string, n: number): void {
  if (!Number.isInteger(n)) throw new TypeError(`${label} must be an integer number of cents`)
}

/**
 * The entries for one billing cycle charge.
 *
 * Built from the same CycleQuote the customer was shown at checkout, so the
 * ledger cannot drift from the quote -- there is no second place where the
 * fee is recalculated.
 */
export function chargeEntries(args: {
  quote: CycleQuote
  subscriptionId: string
  customerUserId: string
  providerUserId: string
  currency?: string
  externalProcessor?: string
  externalId?: string
  idempotencyKey: string
  /**
   * Standing credit consumed by this cycle. The customer_charge is smaller
   * by this much and an adjustment makes up the difference, so the set still
   * sums to zero and the credit cannot be spent twice.
   */
  creditAppliedCents?: number
}): LedgerEntry[] {
  const { quote } = args
  const creditApplied = args.creditAppliedCents ?? 0
  assertWholeCents('creditAppliedCents', creditApplied)
  if (creditApplied < 0) throw new RangeError('creditAppliedCents cannot be negative')
  if (creditApplied > quote.customerTotalCents) {
    throw new RangeError('Cannot apply more credit than the cycle is worth')
  }
  const currency = args.currency ?? 'USD'

  assertWholeCents('customerTotalCents', quote.customerTotalCents)
  assertWholeCents('serviceSubtotalCents', quote.serviceSubtotalCents)
  assertWholeCents('platformFeeCents', quote.platformFeeCents)

  if (quote.customerTotalCents !== quote.serviceSubtotalCents + quote.platformFeeCents) {
    // The quote itself is inconsistent. Refusing here rather than writing
    // an unbalanced set means the bug surfaces at the source.
    throw new RangeError(
      `Quote does not decompose: ${quote.customerTotalCents} != ${quote.serviceSubtotalCents} + ${quote.platformFeeCents}`,
    )
  }

  const common = {
    currency,
    subscriptionId: args.subscriptionId,
    customerUserId: args.customerUserId,
    providerUserId: args.providerUserId,
    externalProcessor: args.externalProcessor,
    externalId: args.externalId,
  }

  const entries: LedgerEntry[] = [
    {
      ...common,
      kind: 'customer_charge',
      amountCents: quote.customerTotalCents - creditApplied,
      // Only the charge carries the key: it is the row that corresponds to
      // the processor event, and the column is unique across the table.
      idempotencyKey: args.idempotencyKey,
      memo: `Cycle charge, ${quote.occurrences} visit(s)`,
    },
    {
      ...common,
      kind: 'provider_earning',
      amountCents: -quote.serviceSubtotalCents,
      memo: 'Provider keeps the listed price',
    },
    {
      ...common,
      kind: 'platform_fee',
      amountCents: -quote.platformFeeCents,
      memo: 'Platform fee',
    },
  ]

  if (creditApplied > 0) {
    entries.push({
      ...common,
      kind: 'adjustment',
      amountCents: creditApplied,
      memo: 'Credit applied to this cycle',
    })
  }

  return entries
}

/**
 * The customer's share of the cycle fee attributable to one visit.
 *
 * Proportional to the actual fee charged rather than a fresh percentage of
 * the visit, so a cycle where the $1 minimum applied reverses the minimum
 * proportionally too instead of inventing a different number.
 */
export function visitFeeShareCents(args: {
  cycleFeeCents: number
  visitValueCents: number
  cycleSubtotalCents: number
}): number {
  if (args.cycleSubtotalCents <= 0) return 0
  return roundHalfUp(args.cycleFeeCents * args.visitValueCents, args.cycleSubtotalCents)
}

/**
 * A credit for a visit that did not happen.
 *
 * THREE entries, netting to zero, because a visit has three sides and all
 * three have to come back.
 *
 * The first draft wrote a single -300 and was wrong twice over. The cycle
 * was charged up front for four visits, so crediting only the customer left
 * the provider holding 300 cents for a visit they never made. Reversing the
 * provider's side as well fixed that but left the platform keeping its 45
 * cents of fee on the same missing visit -- "a cut of work that never
 * happened", which quoteCycle explicitly refuses to take.
 *
 *     credit           -345   the customer paid this for the visit
 *     provider_earning +300   the provider is owed that much less
 *     platform_fee      +45   the platform gives back its cut
 *     -------------------------
 *     sum                 0
 *
 * The customer's 345 stays outstanding as a standing credit until the next
 * cycle's charge consumes it. The other two land immediately: neither party
 * should show as owed for work nobody did.
 */
export function creditEntries(args: {
  /** The visit's service value. What the provider would have earned. */
  serviceCents: number
  /** That visit's share of the cycle fee. See visitFeeShareCents. */
  feeShareCents: number
  subscriptionId: string
  occurrenceId: string
  customerUserId: string
  providerUserId: string
  currency?: string
  memo?: string
  idempotencyKey?: string
}): LedgerEntry[] {
  assertWholeCents('serviceCents', args.serviceCents)
  assertWholeCents('feeShareCents', args.feeShareCents)
  if (args.serviceCents < 0 || args.feeShareCents < 0) {
    throw new RangeError('Pass positive amounts; the signs are applied here')
  }

  const common = {
    currency: args.currency ?? 'USD',
    subscriptionId: args.subscriptionId,
    occurrenceId: args.occurrenceId,
    customerUserId: args.customerUserId,
    providerUserId: args.providerUserId,
  }

  const entries: LedgerEntry[] = [
    {
      ...common,
      kind: 'credit',
      amountCents: -(args.serviceCents + args.feeShareCents),
      idempotencyKey: args.idempotencyKey,
      memo: args.memo ?? 'Service credit',
    },
    {
      ...common,
      kind: 'provider_earning',
      amountCents: args.serviceCents,
      memo: 'Reversal: visit not delivered',
    },
  ]

  // Omit a zero fee row rather than writing noise -- a zero-fee service, or
  // a cycle that was already fully credited.
  if (args.feeShareCents > 0) {
    entries.push({
      ...common,
      kind: 'platform_fee',
      amountCents: args.feeShareCents,
      memo: 'Reversal: no fee on an undelivered visit',
    })
  }

  return entries
}

/**
 * Standing credit a customer has not yet spent, in cents.
 *
 * Credits are negative and the adjustment that consumes one at settlement is
 * positive, so what is left is the negated sum of the two kinds.
 */
export function standingCreditCents(entries: readonly LedgerEntry[]): number {
  const relevant = entries.filter((e) => e.kind === 'credit' || e.kind === 'adjustment')
  const owed = -sumCents(relevant)
  return owed <= 0 ? 0 : owed
}

/** Money actually sent to a provider. Settles accumulated earnings. */
export function payoutEntry(args: {
  amountCents: number
  providerUserId: string
  currency?: string
  externalProcessor?: string
  externalId?: string
  idempotencyKey: string
  memo?: string
}): LedgerEntry {
  assertWholeCents('amountCents', args.amountCents)
  if (args.amountCents < 0) throw new RangeError('Pass a positive amount; the sign is applied here')

  return {
    kind: 'payout',
    amountCents: args.amountCents,
    currency: args.currency ?? 'USD',
    providerUserId: args.providerUserId,
    externalProcessor: args.externalProcessor,
    externalId: args.externalId,
    idempotencyKey: args.idempotencyKey,
    memo: args.memo ?? 'Payout to provider',
  }
}

/**
 * What a provider is still owed, in cents.
 *
 * provider_earning is negative (a liability) and payout is positive
 * (discharging it), so the owed amount is the negated sum. Never returns
 * below zero: an over-payout is a real problem, but it is not a debt the
 * provider owes back, and surfacing it as one would be wrong.
 */
export function providerBalanceCents(entries: readonly LedgerEntry[]): number {
  const relevant = entries.filter((e) => e.kind === 'provider_earning' || e.kind === 'payout')
  const owed = -sumCents(relevant)
  return owed <= 0 ? 0 : owed
}

/** Platform revenue recognised, in cents. Fees are stored negative. */
export function platformRevenueCents(entries: readonly LedgerEntry[]): number {
  const revenue = -sumCents(entries.filter((e) => e.kind === 'platform_fee'))
  return revenue === 0 ? 0 : revenue
}

/**
 * Idempotency key for a cycle charge.
 *
 * Deterministic from the things that identify the event, so a retry of the
 * same cycle produces the same key and the unique index refuses the second
 * insert. TECHNICAL_SPEC section 11.
 */
export function cycleChargeKey(args: { subscriptionId: string; cycleStartIso: string }): string {
  return `charge:${args.subscriptionId}:${args.cycleStartIso}`
}
