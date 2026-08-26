import { describe, expect, it } from 'vitest'
import { planSettlement, cycleIsDue, type CycleOccurrence } from '../settlement'
import { DEFAULT_FEE } from '../money'
import { isoDate } from '../schedule'
import type { PlainDate } from '../age'

const d = (y: number, m: number, day: number): PlainDate => ({ year: y, month: m, day })

const CYCLE_END = d(2026, 9, 28)

const BASE = {
  cycleEnd: CYCLE_END,
  billingCycleWeeks: 4,
  priceCents: 300,
  priceUnit: 'week' as const,
  fee: DEFAULT_FEE,
  standingCreditCents: 0,
}

function occ(id: string, state: CycleOccurrence['state'], day = 1): CycleOccurrence {
  return { id, state, serviceDate: d(2026, 9, day) }
}

describe('closing the cycle', () => {
  it('settles delivered work', () => {
    const plan = planSettlement({
      ...BASE,
      closingOccurrences: [occ('a', 'completed', 1), occ('b', 'completed', 8)],
    })
    expect(plan.toSettle).toEqual(['a', 'b'])
  })

  it('leaves credited and canceled visits alone', () => {
    const plan = planSettlement({
      ...BASE,
      closingOccurrences: [occ('a', 'credited'), occ('b', 'canceled'), occ('c', 'completed')],
    })
    expect(plan.toSettle).toEqual(['c'])
    expect(plan.unresolved).toEqual([])
  })

  it('does not re-settle work already settled', () => {
    const plan = planSettlement({ ...BASE, closingOccurrences: [occ('a', 'settled')] })
    expect(plan.toSettle).toEqual([])
  })

  it('reports work nobody resolved instead of guessing', () => {
    const plan = planSettlement({
      ...BASE,
      closingOccurrences: [occ('a', 'due_today'), occ('b', 'started'), occ('c', 'completed')],
    })
    expect(plan.unresolved).toEqual(['a', 'b'])
    // Crucially, they are not settled -- the provider is not paid for work
    // with no evidence -- and not credited either.
    expect(plan.toSettle).toEqual(['c'])
  })

  it('leaves an open issue to trust and safety', () => {
    const plan = planSettlement({ ...BASE, closingOccurrences: [occ('a', 'issue_reported')] })
    expect(plan.toSettle).toEqual([])
    expect(plan.unresolved).toEqual([])
  })
})

describe('opening the next cycle', () => {
  it('starts the day after the old one ends', () => {
    const plan = planSettlement({ ...BASE, closingOccurrences: [] })
    expect(isoDate(plan.nextCycleStart)).toBe('2026-09-29')
  })

  it('runs for the configured number of weeks', () => {
    const plan = planSettlement({ ...BASE, closingOccurrences: [] })
    // 29 Sept + 28 days - 1 = 26 Oct
    expect(isoDate(plan.nextCycleEnd)).toBe('2026-10-26')
  })

  it('handles a one-week cycle', () => {
    const plan = planSettlement({ ...BASE, billingCycleWeeks: 1, closingOccurrences: [] })
    expect(isoDate(plan.nextCycleStart)).toBe('2026-09-29')
    expect(isoDate(plan.nextCycleEnd)).toBe('2026-10-05')
  })

  it('crosses a year boundary', () => {
    const plan = planSettlement({
      ...BASE,
      cycleEnd: d(2026, 12, 28),
      closingOccurrences: [],
    })
    expect(isoDate(plan.nextCycleStart)).toBe('2026-12-29')
    expect(isoDate(plan.nextCycleEnd)).toBe('2027-01-25')
  })

  it('quotes the cycle at full price, per PRD section 12', () => {
    const plan = planSettlement({ ...BASE, closingOccurrences: [] })
    expect(plan.quote.serviceSubtotalCents).toBe(1200)
    expect(plan.quote.platformFeeCents).toBe(180)
    expect(plan.quote.customerTotalCents).toBe(1380)
    expect(plan.amountToChargeCents).toBe(1380)
  })
})

describe('applying standing credit', () => {
  it('takes the credit off the charge', () => {
    const plan = planSettlement({ ...BASE, closingOccurrences: [], standingCreditCents: 345 })
    expect(plan.creditAppliedCents).toBe(345)
    expect(plan.amountToChargeCents).toBe(1380 - 345)
  })

  it('quotes full price regardless -- the discount is explicit, not hidden', () => {
    const plan = planSettlement({ ...BASE, closingOccurrences: [], standingCreditCents: 345 })
    expect(plan.quote.customerTotalCents).toBe(1380)
  })

  it('never applies more credit than the cycle is worth', () => {
    const plan = planSettlement({ ...BASE, closingOccurrences: [], standingCreditCents: 99999 })
    expect(plan.creditAppliedCents).toBe(1380)
    expect(plan.amountToChargeCents).toBe(0)
  })

  it('carries the rest forward rather than refunding it here', () => {
    const plan = planSettlement({ ...BASE, closingOccurrences: [], standingCreditCents: 2000 })
    expect(plan.standingCreditCents - plan.creditAppliedCents).toBe(620)
  })

  it('charges nothing when credit exactly covers the cycle', () => {
    const plan = planSettlement({ ...BASE, closingOccurrences: [], standingCreditCents: 1380 })
    expect(plan.amountToChargeCents).toBe(0)
    expect(plan.creditAppliedCents).toBe(1380)
  })

  it('rejects a negative or fractional credit rather than charging something odd', () => {
    expect(() =>
      planSettlement({ ...BASE, closingOccurrences: [], standingCreditCents: -1 }),
    ).toThrow(RangeError)
    expect(() =>
      planSettlement({ ...BASE, closingOccurrences: [], standingCreditCents: 10.5 }),
    ).toThrow(RangeError)
  })
})

describe('cycleIsDue', () => {
  it('is not due on the last day of the cycle', () => {
    expect(cycleIsDue({ cycleEnd: CYCLE_END, today: CYCLE_END })).toBe(false)
  })

  it('is due the day after', () => {
    expect(cycleIsDue({ cycleEnd: CYCLE_END, today: d(2026, 9, 29) })).toBe(true)
  })

  it('is not due before the end', () => {
    expect(cycleIsDue({ cycleEnd: CYCLE_END, today: d(2026, 9, 27) })).toBe(false)
  })

  it('stays due if a run was missed', () => {
    expect(cycleIsDue({ cycleEnd: CYCLE_END, today: d(2026, 10, 15) })).toBe(true)
  })
})

describe('guards', () => {
  it('refuses a nonsense cycle length', () => {
    expect(() =>
      planSettlement({ ...BASE, billingCycleWeeks: 0, closingOccurrences: [] }),
    ).toThrow(RangeError)
  })
})
