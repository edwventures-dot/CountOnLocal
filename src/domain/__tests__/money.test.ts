import { describe, it, expect } from 'vitest'
import { quoteCycle, roundHalfUp, formatCents, DEFAULT_FEE } from '../money'

describe('the worked example from PRD section 12', () => {
  it('prices a $3/week bin service on a 4-week cycle exactly as documented', () => {
    const q = quoteCycle({ priceCents: 300, priceUnit: 'week', billingCycleWeeks: 4 })
    expect(q.occurrences).toBe(4)
    expect(q.serviceSubtotalCents).toBe(1200)
    expect(q.platformFeeCents).toBe(180)
    expect(q.customerTotalCents).toBe(1380)
    expect(q.providerEarningCents).toBe(1200)
    expect(q.minimumApplied).toBe(false)
  })

  it('displays as the amounts in the spec', () => {
    const q = quoteCycle({ priceCents: 300, priceUnit: 'week', billingCycleWeeks: 4 })
    expect(formatCents(q.serviceSubtotalCents)).toBe('$12.00')
    expect(formatCents(q.platformFeeCents)).toBe('$1.80')
    expect(formatCents(q.customerTotalCents)).toBe('$13.80')
  })
})

describe('the provider keeps their listed price', () => {
  it('credits the provider the full subtotal, never net of the fee', () => {
    for (const priceCents of [100, 250, 300, 999, 1234, 5000]) {
      const q = quoteCycle({ priceCents, priceUnit: 'week', billingCycleWeeks: 4 })
      expect(q.providerEarningCents).toBe(q.serviceSubtotalCents)
      expect(q.providerEarningCents).toBe(priceCents * 4)
    }
  })

  it('adds the fee on top of the price rather than taking it out', () => {
    const q = quoteCycle({ priceCents: 300, priceUnit: 'week', billingCycleWeeks: 4 })
    expect(q.customerTotalCents).toBeGreaterThan(q.providerEarningCents)
    expect(q.customerTotalCents - q.platformFeeCents).toBe(q.providerEarningCents)
  })
})

describe('everything stays an integer', () => {
  it('never produces a fractional cent for any price in a wide range', () => {
    for (let priceCents = 1; priceCents <= 2000; priceCents += 7) {
      const q = quoteCycle({ priceCents, priceUnit: 'week', billingCycleWeeks: 4 })
      for (const v of [
        q.serviceSubtotalCents,
        q.platformFeeCents,
        q.customerTotalCents,
        q.providerEarningCents,
      ]) {
        expect(Number.isInteger(v)).toBe(true)
      }
    }
  })

  it('always balances: total equals subtotal plus fee', () => {
    for (let priceCents = 1; priceCents <= 3000; priceCents += 13) {
      for (const weeks of [1, 2, 4]) {
        const q = quoteCycle({ priceCents, priceUnit: 'week', billingCycleWeeks: weeks })
        expect(q.customerTotalCents).toBe(q.serviceSubtotalCents + q.platformFeeCents)
      }
    }
  })

  it('rejects a non-integer or non-positive price rather than coercing it', () => {
    expect(() => quoteCycle({ priceCents: 3.5, priceUnit: 'week', billingCycleWeeks: 4 })).toThrow()
    expect(() => quoteCycle({ priceCents: 0, priceUnit: 'week', billingCycleWeeks: 4 })).toThrow()
    expect(() => quoteCycle({ priceCents: -300, priceUnit: 'week', billingCycleWeeks: 4 })).toThrow()
  })
})

describe('rounding', () => {
  it('rounds half away from zero, matching a phone calculator', () => {
    expect(roundHalfUp(5, 2)).toBe(3)
    expect(roundHalfUp(7, 2)).toBe(4)
    expect(roundHalfUp(4, 2)).toBe(2)
    expect(roundHalfUp(0, 2)).toBe(0)
  })

  it('rounds a fee that lands on half a cent upward', () => {
    // $12.50 subtotal at 15% is 187.5 cents.
    const q = quoteCycle({ priceCents: 1250, priceUnit: 'visit', billingCycleWeeks: 4 })
    expect(q.serviceSubtotalCents).toBe(1250)
    expect(q.platformFeeCents).toBe(188)
  })
})

describe('the minimum fee', () => {
  it('floors a small cycle at $1.00', () => {
    // $1/week for 4 weeks is $4.00; 15% would be 60 cents.
    const q = quoteCycle({ priceCents: 100, priceUnit: 'week', billingCycleWeeks: 4 })
    expect(q.serviceSubtotalCents).toBe(400)
    expect(q.platformFeeCents).toBe(100)
    expect(q.minimumApplied).toBe(true)
  })

  it('reports the effective rate honestly when the floor bites', () => {
    // 100 cents on a 400 cent subtotal is 25%, not 15%. Cheap services are
    // proportionally more expensive, and the number should say so rather
    // than quietly reporting the headline rate.
    const q = quoteCycle({ priceCents: 100, priceUnit: 'week', billingCycleWeeks: 4 })
    expect(q.effectiveFeeBasisPoints).toBe(2500)
  })

  it('does not apply once the percentage exceeds it', () => {
    const q = quoteCycle({ priceCents: 300, priceUnit: 'week', billingCycleWeeks: 4 })
    expect(q.minimumApplied).toBe(false)
    expect(q.effectiveFeeBasisPoints).toBe(DEFAULT_FEE.percentBasisPoints)
  })
})

describe('price units', () => {
  it('bills a weekly price once per week in the cycle', () => {
    expect(quoteCycle({ priceCents: 300, priceUnit: 'week', billingCycleWeeks: 1 }).occurrences).toBe(1)
    expect(quoteCycle({ priceCents: 300, priceUnit: 'week', billingCycleWeeks: 2 }).occurrences).toBe(2)
    expect(quoteCycle({ priceCents: 300, priceUnit: 'week', billingCycleWeeks: 4 }).occurrences).toBe(4)
  })

  it('bills a per-visit or monthly price once per cycle', () => {
    // The schedule decides how many visits happen, not the price unit, so
    // there is deliberately no multiplication here.
    expect(quoteCycle({ priceCents: 2500, priceUnit: 'visit', billingCycleWeeks: 4 }).serviceSubtotalCents).toBe(2500)
    expect(quoteCycle({ priceCents: 2500, priceUnit: 'month', billingCycleWeeks: 4 }).serviceSubtotalCents).toBe(2500)
  })
})

describe('credits from skipped occurrences', () => {
  it('reduces the subtotal and the fee together', () => {
    // PRD section 12: a provider-canceled occurrence creates a proportional
    // credit against the next bill. Charging a full fee on a credited cycle
    // would take a cut of work that never happened.
    const q = quoteCycle({
      priceCents: 300,
      priceUnit: 'week',
      billingCycleWeeks: 4,
      creditCents: 300,
    })
    expect(q.serviceSubtotalCents).toBe(900)
    expect(q.platformFeeCents).toBe(135)
    expect(q.customerTotalCents).toBe(1035)
  })

  it('charges nothing at all when a cycle is fully credited', () => {
    const q = quoteCycle({
      priceCents: 300,
      priceUnit: 'week',
      billingCycleWeeks: 4,
      creditCents: 1200,
    })
    expect(q.serviceSubtotalCents).toBe(0)
    // The $1 floor must not turn a fully credited cycle into a $1 charge.
    expect(q.platformFeeCents).toBe(0)
    expect(q.customerTotalCents).toBe(0)
    expect(q.minimumApplied).toBe(false)
  })

  it('never goes negative when the credit exceeds the cycle', () => {
    const q = quoteCycle({
      priceCents: 300,
      priceUnit: 'week',
      billingCycleWeeks: 4,
      creditCents: 5000,
    })
    expect(q.serviceSubtotalCents).toBe(0)
    expect(q.customerTotalCents).toBe(0)
  })

  it('rejects a negative credit', () => {
    expect(() =>
      quoteCycle({ priceCents: 300, priceUnit: 'week', billingCycleWeeks: 4, creditCents: -100 }),
    ).toThrow()
  })
})

describe('the fee is configuration, not a constant', () => {
  it('honours a different rate', () => {
    const q = quoteCycle({
      priceCents: 300,
      priceUnit: 'week',
      billingCycleWeeks: 4,
      fee: { percentBasisPoints: 1000, minimumCents: 100 },
    })
    expect(q.platformFeeCents).toBe(120)
  })

  it('honours a zero rate with no minimum', () => {
    const q = quoteCycle({
      priceCents: 300,
      priceUnit: 'week',
      billingCycleWeeks: 4,
      fee: { percentBasisPoints: 0, minimumCents: 0 },
    })
    expect(q.platformFeeCents).toBe(0)
    expect(q.customerTotalCents).toBe(q.providerEarningCents)
  })
})

describe('formatting', () => {
  it('formats cents without floating point drift', () => {
    expect(formatCents(0)).toBe('$0.00')
    expect(formatCents(5)).toBe('$0.05')
    expect(formatCents(1380)).toBe('$13.80')
    expect(formatCents(100000)).toBe('$1,000.00')
  })
})
