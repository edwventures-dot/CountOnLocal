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

export type ReferralLedgerEntry = {
  kind: 'platform_fee' | 'provider_earning' | 'adjustment'
  amountCents: number
  memo: string
}

/**
 * The entries that pay a referring provider their bonus.
 *
 * Two, netting to zero:
 *
 *     provider_earning  -500   the platform now owes the provider this
 *     platform_fee      +500   and gives up that much of its own revenue
 *
 * The sign convention is the platform's, as everywhere in the ledger: a
 * negative provider_earning is money owed out. Note the provider's earnings
 * go UP by the bonus while the platform's fee revenue goes DOWN by the same
 * amount -- which is what "platform-fee-sponsored" means in entries rather
 * than in prose.
 */
export function providerBonusEntries(args: {
  bonusCents: number
}): ReferralLedgerEntry[] {
  if (!Number.isInteger(args.bonusCents) || args.bonusCents < 0) {
    throw new RangeError('bonusCents must be a non-negative integer')
  }
  if (args.bonusCents === 0) return []

  return [
    {
      kind: 'provider_earning',
      amountCents: -args.bonusCents,
      memo: 'Referral bonus, funded from the platform fee',
    },
    {
      kind: 'platform_fee',
      amountCents: args.bonusCents,
      memo: 'Referral bonus given up from fee revenue',
    },
  ]
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
