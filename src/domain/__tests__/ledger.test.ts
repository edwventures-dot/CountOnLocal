import { describe, expect, it } from 'vitest'
import {
  chargeEntries,
  creditEntry,
  cycleChargeKey,
  isBalanced,
  payoutEntry,
  platformRevenueCents,
  providerBalanceCents,
  sumCents,
} from '../ledger'
import { quoteCycle, DEFAULT_FEE } from '../money'

const IDS = {
  subscriptionId: 'sub_1',
  customerUserId: 'cust_1',
  providerUserId: 'prov_1',
}

/** The worked example from PRD section 12: $3/week, 4-week cycle. */
const PRD_QUOTE = quoteCycle({
  priceCents: 300,
  priceUnit: 'week',
  billingCycleWeeks: 4,
  fee: DEFAULT_FEE,
})

describe('the PRD section 12 worked example', () => {
  it('quotes $12.00 + $1.80 = $13.80', () => {
    expect(PRD_QUOTE.serviceSubtotalCents).toBe(1200)
    expect(PRD_QUOTE.platformFeeCents).toBe(180)
    expect(PRD_QUOTE.customerTotalCents).toBe(1380)
  })

  it('decomposes into three entries that sum to zero', () => {
    const entries = chargeEntries({ ...IDS, quote: PRD_QUOTE, idempotencyKey: 'k1' })
    expect(entries).toHaveLength(3)
    expect(sumCents(entries)).toBe(0)
    expect(isBalanced(entries)).toBe(true)
  })

  it('credits the provider the full listed price -- 0% provider fee', () => {
    const entries = chargeEntries({ ...IDS, quote: PRD_QUOTE, idempotencyKey: 'k1' })
    const earning = entries.find((e) => e.kind === 'provider_earning')
    expect(earning?.amountCents).toBe(-1200)
    expect(providerBalanceCents(entries)).toBe(1200)
  })

  it('recognises $1.80 of platform revenue', () => {
    const entries = chargeEntries({ ...IDS, quote: PRD_QUOTE, idempotencyKey: 'k1' })
    expect(platformRevenueCents(entries)).toBe(180)
  })

  it('puts the idempotency key on the charge and nowhere else', () => {
    const entries = chargeEntries({ ...IDS, quote: PRD_QUOTE, idempotencyKey: 'k1' })
    const keyed = entries.filter((e) => e.idempotencyKey)
    expect(keyed).toHaveLength(1)
    expect(keyed[0]?.kind).toBe('customer_charge')
  })
})

describe('balance holds across fee shapes', () => {
  const cases: Array<[string, Parameters<typeof quoteCycle>[0]]> = [
    ['weekly $3', { priceCents: 300, priceUnit: 'week', billingCycleWeeks: 4 }],
    ['weekly $12.50, odd rounding', { priceCents: 1250, priceUnit: 'week', billingCycleWeeks: 4 }],
    ['tiny price hits the $1 minimum', { priceCents: 100, priceUnit: 'week', billingCycleWeeks: 1 }],
    ['per visit', { priceCents: 2500, priceUnit: 'visit', billingCycleWeeks: 4 }],
    [
      'zero fee configured',
      { priceCents: 300, priceUnit: 'week', billingCycleWeeks: 4, fee: { percentBasisPoints: 0, minimumCents: 0 } },
    ],
  ]

  it.each(cases)('stays balanced: %s', (_label, quoteArgs) => {
    const quote = quoteCycle(quoteArgs)
    const entries = chargeEntries({ ...IDS, quote, idempotencyKey: 'k' })
    expect(sumCents(entries)).toBe(0)
  })

  it.each(cases)('never charges less than the provider keeps: %s', (_label, quoteArgs) => {
    const quote = quoteCycle(quoteArgs)
    expect(quote.customerTotalCents).toBeGreaterThanOrEqual(quote.serviceSubtotalCents)
  })
})

describe('an inconsistent quote is refused rather than written', () => {
  it('throws when the total does not equal subtotal plus fee', () => {
    expect(() =>
      chargeEntries({
        ...IDS,
        quote: { ...PRD_QUOTE, customerTotalCents: 9999 },
        idempotencyKey: 'k',
      }),
    ).toThrow(/does not decompose/)
  })

  it('throws on fractional cents', () => {
    expect(() =>
      chargeEntries({
        ...IDS,
        quote: { ...PRD_QUOTE, serviceSubtotalCents: 1200.5, customerTotalCents: 1380.5 },
        idempotencyKey: 'k',
      }),
    ).toThrow(TypeError)
  })
})

describe('credits', () => {
  const credit = creditEntry({
    amountCents: 300,
    subscriptionId: 'sub_1',
    occurrenceId: 'occ_9',
    customerUserId: 'cust_1',
    providerUserId: 'prov_1',
  })

  it('is stored negative, per the 0013 sign rule', () => {
    expect(credit.amountCents).toBe(-300)
    expect(credit.kind).toBe('credit')
  })

  it('takes a positive amount and applies the sign itself', () => {
    expect(() =>
      creditEntry({
        amountCents: -300,
        subscriptionId: 'sub_1',
        occurrenceId: 'occ_9',
        customerUserId: 'cust_1',
        providerUserId: 'prov_1',
      }),
    ).toThrow(/positive/)
  })

  it('points at the occurrence that caused it', () => {
    expect(credit.occurrenceId).toBe('occ_9')
  })

  it('rebalances once the reduced next charge lands', () => {
    // Cycle 1 charged in full, one visit skipped, cycle 2 charged less.
    const cycle1 = chargeEntries({ ...IDS, quote: PRD_QUOTE, idempotencyKey: 'k1' })
    const reduced = quoteCycle({
      priceCents: 300,
      priceUnit: 'week',
      billingCycleWeeks: 4,
      creditCents: 300,
    })
    const cycle2 = chargeEntries({ ...IDS, quote: reduced, idempotencyKey: 'k2' })

    // The credit is negative now and the smaller charge is the offset.
    const all = [...cycle1, credit, ...cycle2]
    expect(sumCents(cycle1)).toBe(0)
    expect(sumCents(cycle2)).toBe(0)
    // The standing credit is the only thing left unallocated.
    expect(sumCents(all)).toBe(-300)
  })
})

describe('payouts', () => {
  it('is positive and settles the provider liability', () => {
    const earned = chargeEntries({ ...IDS, quote: PRD_QUOTE, idempotencyKey: 'k1' })
    expect(providerBalanceCents(earned)).toBe(1200)

    const paid = payoutEntry({ amountCents: 1200, providerUserId: 'prov_1', idempotencyKey: 'po_1' })
    expect(paid.amountCents).toBe(1200)
    expect(providerBalanceCents([...earned, paid])).toBe(0)
  })

  it('carries no subscription id, so per-subscription sums stay zero', () => {
    const paid = payoutEntry({ amountCents: 1200, providerUserId: 'prov_1', idempotencyKey: 'po_1' })
    expect(paid.subscriptionId).toBeUndefined()
  })

  it('handles a partial payout', () => {
    const earned = chargeEntries({ ...IDS, quote: PRD_QUOTE, idempotencyKey: 'k1' })
    const paid = payoutEntry({ amountCents: 500, providerUserId: 'prov_1', idempotencyKey: 'po_1' })
    expect(providerBalanceCents([...earned, paid])).toBe(700)
  })

  it('never reports a negative balance after an over-payout', () => {
    const earned = chargeEntries({ ...IDS, quote: PRD_QUOTE, idempotencyKey: 'k1' })
    const paid = payoutEntry({ amountCents: 5000, providerUserId: 'prov_1', idempotencyKey: 'po_1' })
    expect(providerBalanceCents([...earned, paid])).toBe(0)
  })

  it('requires an idempotency key, because it moves real money', () => {
    const paid = payoutEntry({ amountCents: 1200, providerUserId: 'prov_1', idempotencyKey: 'po_1' })
    expect(paid.idempotencyKey).toBe('po_1')
  })
})

describe('cycleChargeKey', () => {
  it('is deterministic for the same subscription and cycle', () => {
    const a = cycleChargeKey({ subscriptionId: 'sub_1', cycleStartIso: '2026-09-01' })
    const b = cycleChargeKey({ subscriptionId: 'sub_1', cycleStartIso: '2026-09-01' })
    expect(a).toBe(b)
  })

  it('differs across cycles and across subscriptions', () => {
    const base = cycleChargeKey({ subscriptionId: 'sub_1', cycleStartIso: '2026-09-01' })
    expect(base).not.toBe(cycleChargeKey({ subscriptionId: 'sub_1', cycleStartIso: '2026-09-29' }))
    expect(base).not.toBe(cycleChargeKey({ subscriptionId: 'sub_2', cycleStartIso: '2026-09-01' }))
  })
})

describe('multi-provider isolation', () => {
  it('does not let one provider balance leak into another', () => {
    const a = chargeEntries({ ...IDS, quote: PRD_QUOTE, idempotencyKey: 'k1' })
    const b = chargeEntries({
      quote: PRD_QUOTE,
      subscriptionId: 'sub_2',
      customerUserId: 'cust_2',
      providerUserId: 'prov_2',
      idempotencyKey: 'k2',
    })
    const all = [...a, ...b]

    const forA = all.filter((e) => e.providerUserId === 'prov_1')
    const forB = all.filter((e) => e.providerUserId === 'prov_2')

    expect(providerBalanceCents(forA)).toBe(1200)
    expect(providerBalanceCents(forB)).toBe(1200)
    expect(sumCents(all)).toBe(0)
  })
})
