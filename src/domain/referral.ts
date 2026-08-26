/**
 * Referral rewards.
 *
 * UX_UI_SPEC section 13's V1 recommendation: "customer receives first-cycle
 * platform-fee discount; provider receives a platform-fee-sponsored bonus
 * after qualifying paid occurrence."
 *
 * ## Both rewards come out of the platform fee. Neither touches the provider
 *
 * That phrase -- "platform-fee-sponsored" -- is the whole design. CLAUDE.md
 * rule 5 is that the provider keeps the listed price and the provider fee
 * is 0%, and a referral programme funded from provider earnings would
 * quietly repeal it: a fourteen-year-old would find that running a
 * promotion they never agreed to had cost them money.
 *
 * So a reward reduces what the platform keeps. Every entry set below leaves
 * provider_earning at exactly the listed price, and there are tests
 * asserting it rather than comments hoping for it.
 *
 * The platform can also end up with negative fee revenue on a cycle, when a
 * discount plus a bonus exceeds the fee on a small service. That is
 * allowed. Paying to acquire a customer is what a referral programme is,
 * and clamping it at zero would silently make the reward smaller than the
 * one advertised.
 */

import { roundHalfUp } from './money'
import type { CycleQuote } from './money'

/**
 * Share of the first cycle's platform fee the referred customer does not
 * pay. Basis points, so 10000 is the whole fee.
 */
export const DEFAULT_CUSTOMER_DISCOUNT_BPS = 10_000

/** Flat bonus to the referring provider, once the referral qualifies. */
export const DEFAULT_PROVIDER_BONUS_CENTS = 500

export type ReferralTerms = {
  customerDiscountBps: number
  providerBonusCents: number
}

export const DEFAULT_REFERRAL_TERMS: ReferralTerms = {
  customerDiscountBps: DEFAULT_CUSTOMER_DISCOUNT_BPS,
  providerBonusCents: DEFAULT_PROVIDER_BONUS_CENTS,
}

/**
 * What the referred customer saves on their first cycle.
 *
 * Never more than the fee itself. A discount larger than the fee would
 * start eating the provider's price, which is the one thing this must not
 * do.
 */
export function customerDiscountCents(args: {
  quote: CycleQuote
  terms?: ReferralTerms | undefined
}): number {
  const terms = args.terms ?? DEFAULT_REFERRAL_TERMS

  if (!Number.isInteger(terms.customerDiscountBps) || terms.customerDiscountBps < 0) {
    throw new RangeError('customerDiscountBps must be a non-negative integer')
  }

  const raw = roundHalfUp(args.quote.platformFeeCents * terms.customerDiscountBps, 10_000)
  return Math.min(raw, args.quote.platformFeeCents)
}

export type ReferralState =
  /** Code used at checkout; nothing has been paid yet. */
  | 'pending'
  /** A paid occurrence has been delivered. Rewards may be issued. */
  | 'qualified'
  /** Rewards issued. */
  | 'paid'
  /** Cancelled or refunded before qualifying. */
  | 'void'

/**
 * Has this referral earned its rewards?
 *
 * "After qualifying paid occurrence" -- so a subscription that is charged
 * and then cancelled before anybody does any work does not pay a bonus.
 * Otherwise the programme pays for signups rather than for customers, and
 * the cheapest way to earn it would be to sign up and cancel.
 */
export function referralQualifies(args: {
  cycleWasCharged: boolean
  deliveredOccurrences: number
}): boolean {
  return args.cycleWasCharged && args.deliveredOccurrences >= 1
}

export type DiscountedQuote = {
  /** Unchanged. The provider keeps the listed price. */
  serviceSubtotalCents: number
  /** What the platform keeps after the discount. May be zero. */
  platformFeeCents: number
  /** What the customer pays. */
  customerTotalCents: number
  discountCents: number
}

/**
 * Applies a first-cycle discount to a quote.
 *
 * serviceSubtotalCents is returned untouched, deliberately and visibly. If
 * this function ever reduced it, a provider would be paying for a
 * promotion they did not run.
 */
export function applyCustomerDiscount(args: {
  quote: CycleQuote
  terms?: ReferralTerms | undefined
}): DiscountedQuote {
  const discountCents = customerDiscountCents(args)

  return {
    serviceSubtotalCents: args.quote.serviceSubtotalCents,
    platformFeeCents: args.quote.platformFeeCents - discountCents,
    customerTotalCents: args.quote.customerTotalCents - discountCents,
    discountCents,
  }
}

/**
 * The same discount, expressed as a CycleQuote settlement can charge.
 *
 * Settlement builds its ledger entries from a quote, and chargeEntries
 * refuses a quote that does not decompose. Returning a real quote rather
 * than a summary means the discount flows through the existing charge path
 * with no second place where a fee is recalculated -- which is the property
 * that keeps the ledger from drifting away from what the customer was
 * shown.
 */
export function discountQuote(args: {
  quote: CycleQuote
  terms?: ReferralTerms | undefined
}): { quote: CycleQuote; discountCents: number } {
  const discountCents = customerDiscountCents(args)
  if (discountCents === 0) return { quote: args.quote, discountCents: 0 }

  const platformFeeCents = args.quote.platformFeeCents - discountCents

  return {
    discountCents,
    quote: {
      ...args.quote,
      platformFeeCents,
      customerTotalCents: args.quote.customerTotalCents - discountCents,
      // Untouched, and named here so a future edit has to notice it.
      serviceSubtotalCents: args.quote.serviceSubtotalCents,
      providerEarningCents: args.quote.providerEarningCents,
      effectiveFeeBasisPoints:
        args.quote.serviceSubtotalCents === 0
          ? 0
          : roundHalfUp(platformFeeCents * 10_000, args.quote.serviceSubtotalCents),
      // The floor did not decide this fee; the promotion did. Reporting it
      // as still applied would tell a reconciler the minimum was honoured
      // on a cycle that was deliberately taken below it.
      minimumApplied: false,
    },
  }
}
