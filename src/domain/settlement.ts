/**
 * Closing one billing cycle and opening the next.
 *
 * TECHNICAL_SPEC section 9: the platform computes each cycle from planned
 * billable occurrences, and the charge covers the provider subtotal plus
 * the platform fee. PRD section 12 adds that credits reduce the next bill.
 *
 * This module decides; it does not act. It reads the closing cycle and the
 * ledger and returns a plan -- what to settle, what to charge, how much
 * credit to consume. Charging a card and writing rows happens in the
 * service, which can be told to stop before doing any of it.
 *
 * ## Charging ahead, settling behind
 *
 * A cycle is billed at its start, for work not yet done. So a settlement
 * run does two unrelated things at one moment:
 *
 *   - closes the cycle that just ended, marking delivered work settled;
 *   - opens the next one, charging for what is planned.
 *
 * Keeping them in one function is deliberate. They share a boundary date
 * and a subscription, and splitting them would allow a state where a cycle
 * is charged but the previous one never closed -- which is the shape of
 * every double-billing bug.
 *
 * ## Work that was never resolved
 *
 * An occurrence still sitting in due_today or started when its cycle ends
 * is not settled and not credited. Nobody said whether it happened. This
 * plan reports those rather than guessing: marking them completed would pay
 * a provider for work with no evidence, and crediting them would take money
 * from a provider who may simply have forgotten to tap a button.
 */

import type { PlainDate } from './age'
import { addDays } from './schedule'
import { comparePlainDate } from './age'
import { quoteCycle, type CycleQuote, type FeeConfig, type PriceUnit } from './money'
import type { OccurrenceState } from './occurrence'

export type CycleOccurrence = {
  id: string
  state: OccurrenceState
  serviceDate: PlainDate
}

export type SettlementPlan = {
  /** Delivered work, moving completed -> settled. */
  toSettle: string[]
  /**
   * Occurrences whose cycle ended without anyone resolving them. Surfaced,
   * never auto-decided. Nothing about them moves money.
   */
  unresolved: string[]
  /** The cycle being opened. */
  nextCycleStart: PlainDate
  nextCycleEnd: PlainDate
  /** The full price of the next cycle, before credit. */
  quote: CycleQuote
  /** Credit available before this run. */
  standingCreditCents: number
  /** Credit this run consumes. Never more than the cycle is worth. */
  creditAppliedCents: number
  /** What the card is actually charged. Zero is legitimate. */
  amountToChargeCents: number
}

/**
 * Plans one settlement.
 *
 * `standingCreditCents` comes from the ledger, not from counting skipped
 * occurrences: a credit that failed to write should not be silently
 * re-granted here, and the ledger is the record.
 */
export function planSettlement(args: {
  /** Occurrences belonging to the cycle that is closing. */
  closingOccurrences: readonly CycleOccurrence[]
  /** Boundary. The closing cycle ends on this date; the next starts after. */
  cycleEnd: PlainDate
  billingCycleWeeks: number
  priceCents: number
  priceUnit: PriceUnit
  fee: FeeConfig
  standingCreditCents: number
}): SettlementPlan {
  const { closingOccurrences, cycleEnd, billingCycleWeeks } = args

  if (!Number.isInteger(args.standingCreditCents) || args.standingCreditCents < 0) {
    throw new RangeError('standingCreditCents must be a non-negative integer')
  }
  if (!Number.isInteger(billingCycleWeeks) || billingCycleWeeks <= 0) {
    throw new RangeError('billingCycleWeeks must be a positive integer')
  }

  const toSettle: string[] = []
  const unresolved: string[] = []

  for (const occ of closingOccurrences) {
    if (occ.state === 'completed') {
      toSettle.push(occ.id)
    } else if (occ.state === 'due_today' || occ.state === 'started') {
      unresolved.push(occ.id)
    }
    // Everything else is already terminal for billing purposes: settled,
    // credited, canceled, or an open issue that trust and safety owns.
  }

  const nextCycleStart = addDays(cycleEnd, 1)
  const nextCycleEnd = addDays(nextCycleStart, billingCycleWeeks * 7 - 1)

  // Quoted at full price. The credit is applied as an explicit reduction
  // rather than by shrinking the quote, so the ledger can show what the
  // cycle was worth and what was taken off it -- and so the fee is charged
  // on the work planned, with the fee already reversed on the visit that
  // generated the credit.
  const quote = quoteCycle({
    priceCents: args.priceCents,
    priceUnit: args.priceUnit,
    billingCycleWeeks,
    fee: args.fee,
  })

  const creditAppliedCents = Math.min(args.standingCreditCents, quote.customerTotalCents)
  const amountToChargeCents = quote.customerTotalCents - creditAppliedCents

  return {
    toSettle,
    unresolved,
    nextCycleStart,
    nextCycleEnd,
    quote,
    standingCreditCents: args.standingCreditCents,
    creditAppliedCents,
    amountToChargeCents,
  }
}

/**
 * Is this subscription's cycle over?
 *
 * Compared on civil dates. A cycle ending on the 28th is due for settlement
 * from the 29th in the service's own zone, which is the same "today"
 * question the due-today sweep answers.
 */
export function cycleIsDue(args: { cycleEnd: PlainDate; today: PlainDate }): boolean {
  return comparePlainDate(args.today, args.cycleEnd) > 0
}
