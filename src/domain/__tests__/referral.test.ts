import { describe, expect, it } from 'vitest'
import {
  applyCustomerDiscount,
  customerDiscountCents,
  DEFAULT_PROVIDER_BONUS_CENTS,
  DEFAULT_REFERRAL_TERMS,
  providerBonusEntries,
  referralQualifies,
} from '../referral'
import { DEFAULT_FEE, quoteCycle } from '../money'

/** PRD section 12's worked example: $3/week, 4 weeks, 15% fee. */
const QUOTE = quoteCycle({
  priceCents: 300,
  priceUnit: 'week',
  billingCycleWeeks: 4,
  fee: DEFAULT_FEE,
})

describe('the provider never pays for the promotion', () => {
  it('leaves the listed price untouched by a customer discount', () => {
    // CLAUDE.md rule 5: the provider keeps the listed price, 0% provider
    // fee. A referral funded from earnings would quietly repeal that.
    const d = applyCustomerDiscount({ quote: QUOTE })
    expect(d.serviceSubtotalCents).toBe(QUOTE.serviceSubtotalCents)
    expect(d.serviceSubtotalCents).toBe(1200)
  })

  it('takes the discount entirely out of the platform fee', () => {
    const d = applyCustomerDiscount({ quote: QUOTE })
    expect(d.discountCents).toBe(180)
    expect(d.platformFeeCents).toBe(0)
    expect(d.customerTotalCents).toBe(1200)
  })

  it('never lets a discount reach into the provider price', () => {
    // Even at an absurd rate.
    const d = applyCustomerDiscount({
      quote: QUOTE,
      terms: { customerDiscountBps: 50_000, providerBonusCents: 0 },
    })
    expect(d.discountCents).toBe(QUOTE.platformFeeCents)
    expect(d.serviceSubtotalCents).toBe(1200)
    expect(d.customerTotalCents).toBeGreaterThanOrEqual(d.serviceSubtotalCents)
  })

  it('increases what the provider is owed when a bonus is paid', () => {
    const entries = providerBonusEntries({ bonusCents: 500 })
    const earning = entries.find((e) => e.kind === 'provider_earning')
    // Negative is money owed out, in the platform's sign convention.
    expect(earning!.amountCents).toBe(-500)
  })

  it('takes that bonus out of platform revenue, not the provider price', () => {
    const entries = providerBonusEntries({ bonusCents: 500 })
    const fee = entries.find((e) => e.kind === 'platform_fee')
    expect(fee!.amountCents).toBe(500)
    expect(entries.reduce((a, e) => a + e.amountCents, 0)).toBe(0)
  })
})

describe('the customer discount', () => {
  it('defaults to the whole first-cycle fee', () => {
    expect(DEFAULT_REFERRAL_TERMS.customerDiscountBps).toBe(10_000)
    expect(customerDiscountCents({ quote: QUOTE })).toBe(180)
  })

  it('honours a partial rate', () => {
    const half = customerDiscountCents({
      quote: QUOTE,
      terms: { customerDiscountBps: 5000, providerBonusCents: 0 },
    })
    expect(half).toBe(90)
  })

  it('rounds the way a person would', () => {
    // 15% of a $12.50/week service: fee 750, half of it is 375.
    const quote = quoteCycle({ priceCents: 1250, priceUnit: 'week', billingCycleWeeks: 4 })
    const d = customerDiscountCents({
      quote,
      terms: { customerDiscountBps: 5000, providerBonusCents: 0 },
    })
    expect(d).toBe(Math.round(quote.platformFeeCents / 2))
  })

  it('is zero at a zero rate', () => {
    expect(
      customerDiscountCents({
        quote: QUOTE,
        terms: { customerDiscountBps: 0, providerBonusCents: 0 },
      }),
    ).toBe(0)
  })

  it('refuses a negative rate rather than paying the customer', () => {
    expect(() =>
      customerDiscountCents({
        quote: QUOTE,
        terms: { customerDiscountBps: -1, providerBonusCents: 0 },
      }),
    ).toThrow(RangeError)
  })

  it('handles a cycle where the fee minimum applied', () => {
    // $1/week for one week: percentage fee is 15, minimum lifts it to 100.
    const quote = quoteCycle({ priceCents: 100, priceUnit: 'week', billingCycleWeeks: 1 })
    const d = applyCustomerDiscount({ quote })
    expect(d.discountCents).toBe(quote.platformFeeCents)
    expect(d.serviceSubtotalCents).toBe(100)
  })
})

describe('the provider bonus', () => {
  it('defaults to the documented amount', () => {
    expect(DEFAULT_PROVIDER_BONUS_CENTS).toBe(500)
  })

  it('writes nothing for a zero bonus rather than two empty rows', () => {
    expect(providerBonusEntries({ bonusCents: 0 })).toEqual([])
  })

  it('refuses a negative bonus', () => {
    expect(() => providerBonusEntries({ bonusCents: -100 })).toThrow(RangeError)
  })

  it('refuses fractional cents', () => {
    expect(() => providerBonusEntries({ bonusCents: 12.5 })).toThrow(RangeError)
  })
})

describe('qualifying', () => {
  it('needs both a charge and delivered work', () => {
    expect(referralQualifies({ cycleWasCharged: true, deliveredOccurrences: 1 })).toBe(true)
  })

  it('does not pay for a signup that never became a customer', () => {
    // Otherwise the cheapest way to earn a bonus is to sign up and cancel.
    expect(referralQualifies({ cycleWasCharged: true, deliveredOccurrences: 0 })).toBe(false)
  })

  it('does not pay when nothing was charged', () => {
    expect(referralQualifies({ cycleWasCharged: false, deliveredOccurrences: 3 })).toBe(false)
  })
})

describe('the platform can lose money on a referral, and that is allowed', () => {
  it('lets a discount plus a bonus exceed the fee', () => {
    const discounted = applyCustomerDiscount({ quote: QUOTE })
    const bonus = providerBonusEntries({ bonusCents: 500 })

    // Fee revenue after both: 0 from the discounted cycle, less 500 given
    // up as the bonus.
    const feeAfter =
      discounted.platformFeeCents - bonus.find((e) => e.kind === 'platform_fee')!.amountCents

    expect(feeAfter).toBeLessThan(0)
    // Paying to acquire a customer is what a referral programme is.
    // Clamping at zero would silently pay less than was advertised.
  })

  it('still never reduces the provider earning below the listed price', () => {
    const discounted = applyCustomerDiscount({ quote: QUOTE })
    expect(discounted.serviceSubtotalCents).toBe(1200)
  })
})
