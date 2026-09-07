/**
 * What a provider charges, as information.
 *
 * The platform does not take payment on this branch and never sees a
 * transaction, so there is no fee to compute, no cycle to quote and no
 * ledger to post to. domain/money.ts is gone with the rest of it.
 *
 * A price is still a real thing, though. The provider sets one, the
 * storefront shows it, the flyer prints it, and the customer needs to know
 * what they are agreeing to before somebody turns up at their house. What
 * survives is the unit that price is quoted in.
 *
 * Kept as its own module rather than folded into schedule.ts, because a
 * billing period and a price are different ideas that happened to live near
 * each other, and a branch that puts payments back would grow this file
 * rather than untangle that one.
 */

export type PriceUnit = 'week' | 'visit' | 'month'

/** Cents to a display string. The only money formatting left. */
export function formatPrice(cents: number, unit: PriceUnit): string {
  const dollars = (cents / 100).toFixed(2).replace(/\.00$/, '')
  const suffix = unit === 'visit' ? ' per visit' : unit === 'week' ? ' per week' : ' per month'
  return `$${dollars}${suffix}`
}

/**
 * The most a single visit may be priced at.
 *
 * Carried over from the full product, where it limited how much a customer
 * could be charged in one go. Nothing charges anybody here, so it is no
 * longer a money control -- it is a definition. Count On Local is for small
 * recurring neighbourhood jobs, and a service priced above this is not one
 * of those, whoever is paying whom.
 */
export const MAX_OCCURRENCE_PRICE_CENTS = 5_000

export type PriceCapCheck = { ok: true } | { ok: false; maxCents: number; message: string }

export function checkPriceCap(args: {
  priceCents: number
  priceUnit: PriceUnit
  maxCents?: number
}): PriceCapCheck {
  const maxCents = args.maxCents ?? MAX_OCCURRENCE_PRICE_CENTS
  if (args.priceCents <= maxCents) return { ok: true }

  const dollars = `$${(maxCents / 100).toFixed(2).replace(/\.00$/, '')}`
  return {
    ok: false,
    maxCents,
    // Names the unit the provider typed, so the number in the message is
    // the number in the field they have to change.
    message: `The most a single ${args.priceUnit === 'week' ? 'visit' : args.priceUnit} can be priced at is ${dollars}.`,
  }
}

/** Cents as a plain dollar amount, no unit suffix. */
export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}
