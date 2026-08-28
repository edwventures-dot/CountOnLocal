import { describe, expect, it } from 'vitest'
import { lifetimeEarnedCents, planPayout, type PayoutGate } from '../payout'
import { providerBalanceCents, type LedgerEntry } from '../ledger'

const ALLOWED: PayoutGate = { allowed: true }

const entry = (kind: LedgerEntry['kind'], amountCents: number): LedgerEntry => ({
  kind,
  amountCents,
  currency: 'USD',
})

const plan = (over: Partial<Parameters<typeof planPayout>[0]> = {}) =>
  planPayout({
    providerUserId: 'usr_1',
    balanceCents: 1200,
    lifetimeEarnedCents: 1200,
    held: false,
    gate: ALLOWED,
    ...over,
  })

describe('when money moves', () => {
  it('pays the whole balance', () => {
    expect(plan()).toMatchObject({ pay: true, amountCents: 1200 })
  })

  it('pays a small balance rather than making them wait', () => {
    // Connect transfers cost nothing, so a floor would only mean a
    // fourteen-year-old owed $3 waits for money already theirs.
    expect(plan({ balanceCents: 300, lifetimeEarnedCents: 300 })).toMatchObject({
      pay: true,
      amountCents: 300,
    })
  })

  it('does nothing when nothing is owed', () => {
    expect(plan({ balanceCents: 0 })).toEqual({ pay: false, reason: 'NOTHING_OWED' })
  })

  it('does nothing on a negative balance', () => {
    expect(plan({ balanceCents: -50 })).toEqual({ pay: false, reason: 'NOTHING_OWED' })
  })
})

describe('what stops a payout', () => {
  it('refuses while payouts are held', () => {
    // A hold exists because somebody is looking into something, and
    // "they were owed it anyway" is not a reason to send it meanwhile.
    expect(plan({ held: true })).toEqual({ pay: false, reason: 'ON_HOLD' })
  })

  it('checks the hold before the gate, so the reason is the real one', () => {
    const r = plan({ held: true, gate: { allowed: false, code: 'GUARDIAN_APPROVAL_REQUIRED' } })
    expect(r).toEqual({ pay: false, reason: 'ON_HOLD' })
  })

  it('refuses when the guardian is not cleared', () => {
    expect(plan({ gate: { allowed: false, code: 'GUARDIAN_APPROVAL_REQUIRED' } })).toEqual({
      pay: false,
      reason: 'GUARDIAN_APPROVAL_REQUIRED',
    })
  })

  it('refuses when Stripe onboarding is incomplete', () => {
    expect(plan({ gate: { allowed: false, code: 'PAYOUT_ONBOARDING_INCOMPLETE' } })).toEqual({
      pay: false,
      reason: 'PAYOUT_ONBOARDING_INCOMPLETE',
    })
  })

  it('refuses a provider whose payout account was detached at eighteen', () => {
    expect(plan({ gate: { allowed: false, code: 'GUARDIAN_NOT_LINKED' } })).toEqual({
      pay: false,
      reason: 'GUARDIAN_NOT_LINKED',
    })
  })
})

describe('the idempotency key', () => {
  it('is stable while nothing new is earned', () => {
    // A re-run must return the original transfer, not make a second.
    const a = plan()
    const b = plan()
    expect(a).toEqual(b)
  })

  it('changes as soon as more is earned', () => {
    // The failure this exists to prevent: earn 300, get paid, earn 300
    // again, and a date-based key deduplicates the second transfer
    // against the first -- no money moves and a ledger row is written
    // for a payout that did not happen.
    const first = plan({ balanceCents: 300, lifetimeEarnedCents: 300 })
    const second = plan({ balanceCents: 300, lifetimeEarnedCents: 600 })
    if (first.pay && second.pay) {
      expect(first.idempotencyKey).not.toBe(second.idempotencyKey)
    }
  })

  it('differs between providers owed the same amount', () => {
    const a = plan({ providerUserId: 'usr_1' })
    const b = plan({ providerUserId: 'usr_2' })
    if (a.pay && b.pay) expect(a.idempotencyKey).not.toBe(b.idempotencyKey)
  })
})

describe('lifetime earnings, from the ledger', () => {
  it('sums earnings and ignores everything else', () => {
    const entries = [
      entry('customer_charge', 1380),
      entry('provider_earning', -1200),
      entry('platform_fee', -180),
      entry('payout', 1200),
    ]
    expect(lifetimeEarnedCents(entries)).toBe(1200)
  })

  it('keeps growing after a payout, while the balance returns to zero', () => {
    // This is the property the key depends on.
    const afterFirst = [entry('provider_earning', -1200), entry('payout', 1200)]
    expect(lifetimeEarnedCents(afterFirst)).toBe(1200)
    expect(providerBalanceCents(afterFirst)).toBe(0)

    const afterSecond = [...afterFirst, entry('provider_earning', -300)]
    expect(lifetimeEarnedCents(afterSecond)).toBe(1500)
    expect(providerBalanceCents(afterSecond)).toBe(300)
  })

  it('counts a credit reversal, which reduces what was earned', () => {
    // A provider skip writes provider_earning +300, giving back what they
    // were paid for work they did not do.
    const entries = [entry('provider_earning', -1200), entry('provider_earning', 300)]
    expect(lifetimeEarnedCents(entries)).toBe(900)
    expect(providerBalanceCents(entries)).toBe(900)
  })

  it('never goes negative', () => {
    expect(lifetimeEarnedCents([entry('provider_earning', 500)])).toBe(0)
  })
})
