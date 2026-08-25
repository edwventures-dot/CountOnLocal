/**
 * Money.
 *
 * CLAUDE.md rule 4: integer minor units everywhere, formatted to a display
 * string only at the UI boundary. Nothing in this file returns a float, and
 * nothing accepts dollars.
 *
 * PRD section 12 is the worked example this is built against:
 *
 *   provider list price       $3.00/week      300 cents
 *   4-week service subtotal   $12.00        1,200 cents
 *   platform fee at 15%        $1.80          180 cents
 *   customer charge           $13.80        1,380 cents
 *   provider ledger credit    $12.00        1,200 cents
 *
 * The provider keeps the listed amount. The fee is added on top and charged
 * to the customer -- PRD section 12, "Set your price. Keep your price."
 */

export type PriceUnit = 'week' | 'visit' | 'month'

/**
 * Fee configuration. PRD section 12 calls the fee "a configuration value,
 * not hard-coded", so it is passed in rather than read from a constant here.
 */
export type FeeConfig = {
  /** Basis points, so 15% is 1500. Avoids a float percentage in money math. */
  percentBasisPoints: number
  /** Floor per billing cycle, in cents. */
  minimumCents: number
}

export const DEFAULT_FEE: FeeConfig = {
  percentBasisPoints: 1500,
  minimumCents: 100,
}

/**
 * Rounds half away from zero, on integers only.
 *
 * Chosen over banker's rounding because the result has to match what a
 * customer gets when they check 15% of $12.50 on a phone calculator. A fee
 * that is a cent off from the obvious answer erodes trust out of proportion
 * to the cent.
 */
export function roundHalfUp(numerator: number, denominator: number): number {
  if (!Number.isInteger(numerator)) throw new TypeError('numerator must be an integer')
  const sign = numerator < 0 ? -1 : 1
  const n = Math.abs(numerator)
  return sign * Math.floor((n * 2 + denominator) / (denominator * 2))
}

export type CycleQuote = {
  /** Occurrences billed in this cycle. */
  occurrences: number
  /** What the provider is owed. Their listed price, untouched. */
  serviceSubtotalCents: number
  platformFeeCents: number
  /** What the customer is charged. */
  customerTotalCents: number
  /** Credited to the provider ledger. Always equals the subtotal. */
  providerEarningCents: number
  /** Fee as a share of subtotal, in basis points. Differs from the configured
   *  rate whenever the minimum bites. */
  effectiveFeeBasisPoints: number
  /** True when the floor raised the fee above the percentage. */
  minimumApplied: boolean
}

/**
 * Prices one billing cycle.
 *
 * A weekly service billed on a 4-week cycle bills four occurrences. A
 * per-visit or monthly price bills once per cycle -- there is no arithmetic
 * that turns "per visit" into a number of visits, because the schedule
 * decides that, not the price unit.
 */
export function quoteCycle(args: {
  priceCents: number
  priceUnit: PriceUnit
  billingCycleWeeks: number
  fee?: FeeConfig
  /** Credits carried in from a skipped occurrence, in cents. */
  creditCents?: number
}): CycleQuote {
  const { priceCents, priceUnit, billingCycleWeeks } = args
  const fee = args.fee ?? DEFAULT_FEE
  const creditCents = args.creditCents ?? 0

  if (!Number.isInteger(priceCents) || priceCents <= 0) {
    throw new RangeError('priceCents must be a positive integer')
  }
  if (!Number.isInteger(creditCents) || creditCents < 0) {
    throw new RangeError('creditCents must be a non-negative integer')
  }

  const occurrences = priceUnit === 'week' ? billingCycleWeeks : 1
  const gross = priceCents * occurrences

  // A credit reduces what the provider is owed this cycle, and therefore the
  // fee too -- charging a full fee on a partially credited cycle would take
  // a cut of work that never happened.
  const serviceSubtotalCents = Math.max(0, gross - creditCents)

  const percentFee = roundHalfUp(serviceSubtotalCents * fee.percentBasisPoints, 10_000)
  // A fully credited cycle is not charged at all, so the minimum does not
  // apply to it. Billing a $1 floor on a $0 cycle would be a charge for
  // nothing.
  const platformFeeCents =
    serviceSubtotalCents === 0 ? 0 : Math.max(percentFee, fee.minimumCents)

  return {
    occurrences,
    serviceSubtotalCents,
    platformFeeCents,
    customerTotalCents: serviceSubtotalCents + platformFeeCents,
    providerEarningCents: serviceSubtotalCents,
    effectiveFeeBasisPoints:
      serviceSubtotalCents === 0
        ? 0
        : roundHalfUp(platformFeeCents * 10_000, serviceSubtotalCents),
    minimumApplied: serviceSubtotalCents > 0 && platformFeeCents > percentFee,
  }
}

/** Formats integer cents for display. The only place money becomes a string. */
export function formatCents(cents: number, currency = 'USD'): string {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency })
}
