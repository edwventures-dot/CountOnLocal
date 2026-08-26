import { describe, expect, it } from 'vitest'
import {
  applyCustomerDiscount,
  customerDiscountCents,
  DEFAULT_PROVIDER_BONUS_CENTS,
  DEFAULT_REFERRAL_TERMS,
  discountQuote,
  referralQualifies,
} from '../referral'
import { referralBonusEntries, sumCents } from '../ledger'
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
    const entries = referralBonusEntries({ bonusCents: 500, providerUserId: 'p_1', referralId: 'r_1' })
    const earning = entries.find((e) => e.kind === 'provider_earning')
    // Negative is money owed out, in the platform's sign convention.
    expect(earning!.amountCents).toBe(-500)
  })

  it('takes that bonus out of platform revenue, not the provider price', () => {
    const entries = referralBonusEntries({ bonusCents: 500, providerUserId: 'p_1', referralId: 'r_1' })
    const fee = entries.find((e) => e.kind === 'platform_fee')
    expect(fee!.amountCents).toBe(500)
    expect(sumCents(entries)).toBe(0)
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
    expect(referralBonusEntries({ bonusCents: 0, providerUserId: 'p_1', referralId: 'r_1' })).toEqual([])
  })

  it('refuses a negative bonus', () => {
    expect(() => referralBonusEntries({ bonusCents: -100, providerUserId: 'p_1', referralId: 'r_1' })).toThrow(RangeError)
  })

  it('refuses fractional cents', () => {
    expect(() => referralBonusEntries({ bonusCents: 12.5, providerUserId: 'p_1', referralId: 'r_1' })).toThrow(TypeError)
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
    const bonus = referralBonusEntries({ bonusCents: 500, providerUserId: 'p_1', referralId: 'r_1' })

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

describe('discountQuote', () => {
  it('still decomposes, so chargeEntries will accept it', () => {
    // chargeEntries refuses a quote where total != subtotal + fee. That
    // check is the reason this returns a real quote rather than a summary.
    const { quote } = discountQuote({ quote: QUOTE })
    expect(quote.customerTotalCents).toBe(quote.serviceSubtotalCents + quote.platformFeeCents)
  })

  it('leaves the provider earning alone', () => {
    const { quote } = discountQuote({ quote: QUOTE })
    expect(quote.providerEarningCents).toBe(QUOTE.providerEarningCents)
    expect(quote.serviceSubtotalCents).toBe(QUOTE.serviceSubtotalCents)
  })

  it('returns the original object untouched at a zero discount', () => {
    const result = discountQuote({
      quote: QUOTE,
      terms: { customerDiscountBps: 0, providerBonusCents: 0 },
    })
    expect(result.quote).toBe(QUOTE)
    expect(result.discountCents).toBe(0)
  })

  it('recomputes the effective rate rather than reporting the old one', () => {
    const { quote } = discountQuote({
      quote: QUOTE,
      terms: { customerDiscountBps: 5000, providerBonusCents: 0 },
    })
    // 90 of 1200 is 750bp, not the 1500bp that was charged before.
    expect(quote.effectiveFeeBasisPoints).toBe(750)
  })

  it('stops claiming the minimum applied on a cycle taken below it', () => {
    const small = quoteCycle({ priceCents: 100, priceUnit: 'week', billingCycleWeeks: 1 })
    expect(small.minimumApplied).toBe(true)
    const { quote } = discountQuote({ quote: small })
    // The floor did not decide this fee; the promotion did.
    expect(quote.minimumApplied).toBe(false)
  })
})

describe('the bonus is not attached to a subscription', () => {
  it('carries the provider but no subscription id', () => {
    // The referring provider is usually not the provider on the referred
    // subscription. Attaching it there would break that subscription's
    // per-subscription zero for a movement unrelated to it.
    const entries = referralBonusEntries({
      bonusCents: 500,
      providerUserId: 'p_1',
      referralId: 'r_1',
    })
    for (const e of entries) {
      expect(e.providerUserId).toBe('p_1')
      expect(e.subscriptionId).toBeUndefined()
      expect(e.customerUserId).toBeUndefined()
    }
  })

  it('keys the payout so it cannot be paid twice', () => {
    const entries = referralBonusEntries({
      bonusCents: 500,
      providerUserId: 'p_1',
      referralId: 'r_1',
    })
    const keyed = entries.filter((e) => e.idempotencyKey !== undefined)
    // Exactly one, as with a cycle charge: the column is unique table-wide.
    expect(keyed).toHaveLength(1)
    expect(keyed[0]!.idempotencyKey).toBe('referral_bonus:r_1')
  })
})
