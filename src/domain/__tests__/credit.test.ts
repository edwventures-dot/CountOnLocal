import { describe, expect, it } from 'vitest'
import {
  decideSkipCredit,
  previewCustomerSkip,
  totalCredit,
  DEFAULT_SKIP_POLICY,
  type CreditDecision,
} from '../credit'
import type { PlainDate } from '../age'

const d = (y: number, m: number, day: number): PlainDate => ({ year: y, month: m, day })

// A $3/week service billed in 4-week cycles: one visit is worth $3.
const VISIT = 300
const TUESDAY = d(2026, 9, 1)

describe('provider skips are always credited', () => {
  it('credits the full visit regardless of notice', () => {
    const r = decideSkipCredit({
      reason: 'provider_unavailable',
      occurrenceValueCents: VISIT,
      serviceDate: TUESDAY,
    })
    expect(r.credited).toBe(true)
    expect(r.amountCents).toBe(VISIT)
    expect(r.code).toBe('provider_did_not_deliver')
  })

  it('credits even when the provider cancelled weeks ahead', () => {
    // Notice is irrelevant: the work still was not done.
    const r = decideSkipCredit({
      reason: 'provider_unavailable',
      occurrenceValueCents: VISIT,
      serviceDate: TUESDAY,
      requestedOn: d(2026, 8, 1),
    })
    expect(r.credited).toBe(true)
    expect(r.noticeDays).toBeNull()
  })

  it('does not require requestedOn at all', () => {
    expect(() =>
      decideSkipCredit({
        reason: 'provider_unavailable',
        occurrenceValueCents: VISIT,
        serviceDate: TUESDAY,
      }),
    ).not.toThrow()
  })
})

describe('customer skips turn on notice', () => {
  it('credits a skip made the day before, at the default 1-day policy', () => {
    const r = decideSkipCredit({
      reason: 'customer_requested',
      occurrenceValueCents: VISIT,
      serviceDate: TUESDAY,
      requestedOn: d(2026, 8, 31),
    })
    expect(r.credited).toBe(true)
    expect(r.amountCents).toBe(VISIT)
    expect(r.noticeDays).toBe(1)
    expect(r.code).toBe('customer_gave_notice')
  })

  it('does not credit a same-day skip', () => {
    const r = decideSkipCredit({
      reason: 'customer_requested',
      occurrenceValueCents: VISIT,
      serviceDate: TUESDAY,
      requestedOn: TUESDAY,
    })
    expect(r.credited).toBe(false)
    expect(r.amountCents).toBe(0)
    expect(r.noticeDays).toBe(0)
    expect(r.code).toBe('customer_inside_cutoff')
  })

  it('does not credit a skip requested after the service date', () => {
    const r = decideSkipCredit({
      reason: 'customer_requested',
      occurrenceValueCents: VISIT,
      serviceDate: TUESDAY,
      requestedOn: d(2026, 9, 3),
    })
    expect(r.credited).toBe(false)
    expect(r.noticeDays).toBe(-2)
  })

  it('honours a stricter service policy', () => {
    const r = decideSkipCredit({
      reason: 'customer_requested',
      occurrenceValueCents: VISIT,
      serviceDate: TUESDAY,
      requestedOn: d(2026, 8, 30), // 2 days
      policy: { customerNoticeDays: 3 },
    })
    expect(r.credited).toBe(false)
    expect(r.message).toContain('3 days')
  })

  it('honours a policy of zero notice, where same-day is still free', () => {
    const r = decideSkipCredit({
      reason: 'customer_requested',
      occurrenceValueCents: VISIT,
      serviceDate: TUESDAY,
      requestedOn: TUESDAY,
      policy: { customerNoticeDays: 0 },
    })
    expect(r.credited).toBe(true)
  })

  it('says "1 day" not "1 days"', () => {
    const r = decideSkipCredit({
      reason: 'customer_requested',
      occurrenceValueCents: VISIT,
      serviceDate: TUESDAY,
      requestedOn: TUESDAY,
      policy: { customerNoticeDays: 1 },
    })
    expect(r.message).toContain('1 day ')
    expect(r.message).not.toContain('1 days')
  })

  it('refuses to guess when notice cannot be judged', () => {
    expect(() =>
      decideSkipCredit({
        reason: 'customer_requested',
        occurrenceValueCents: VISIT,
        serviceDate: TUESDAY,
      }),
    ).toThrow(/requestedOn/)
  })
})

describe('notice counting crosses month and year boundaries', () => {
  it('counts across a month end', () => {
    const r = decideSkipCredit({
      reason: 'customer_requested',
      occurrenceValueCents: VISIT,
      serviceDate: d(2026, 3, 1),
      requestedOn: d(2026, 2, 28),
      policy: { customerNoticeDays: 1 },
    })
    expect(r.noticeDays).toBe(1)
    expect(r.credited).toBe(true)
  })

  it('counts across a leap day', () => {
    // 2028 is a leap year, so Feb 28 -> Mar 1 is two days, not one.
    const r = decideSkipCredit({
      reason: 'customer_requested',
      occurrenceValueCents: VISIT,
      serviceDate: d(2028, 3, 1),
      requestedOn: d(2028, 2, 28),
    })
    expect(r.noticeDays).toBe(2)
  })

  it('counts across a year end', () => {
    const r = decideSkipCredit({
      reason: 'customer_requested',
      occurrenceValueCents: VISIT,
      serviceDate: d(2027, 1, 1),
      requestedOn: d(2026, 12, 31),
    })
    expect(r.noticeDays).toBe(1)
  })
})

describe('issue resolved for the customer', () => {
  it('credits the visit', () => {
    const r = decideSkipCredit({
      reason: 'issue_resolved_for_customer',
      occurrenceValueCents: VISIT,
      serviceDate: TUESDAY,
    })
    expect(r.credited).toBe(true)
    expect(r.amountCents).toBe(VISIT)
  })
})

describe('previewCustomerSkip matches the real decision', () => {
  it('agrees with decideSkipCredit for the same day', () => {
    const preview = previewCustomerSkip({
      occurrenceValueCents: VISIT,
      serviceDate: TUESDAY,
      today: d(2026, 8, 31),
    })
    const actual = decideSkipCredit({
      reason: 'customer_requested',
      occurrenceValueCents: VISIT,
      serviceDate: TUESDAY,
      requestedOn: d(2026, 8, 31),
    })
    expect(preview).toEqual(actual)
  })

  it('warns before an uncredited skip so the UI can say so first', () => {
    const preview = previewCustomerSkip({
      occurrenceValueCents: VISIT,
      serviceDate: TUESDAY,
      today: TUESDAY,
    })
    expect(preview.credited).toBe(false)
    expect(preview.message).toMatch(/still be billed/)
  })
})

describe('input guards', () => {
  it('rejects fractional cents', () => {
    expect(() =>
      decideSkipCredit({
        reason: 'provider_unavailable',
        occurrenceValueCents: 300.5,
        serviceDate: TUESDAY,
      }),
    ).toThrow(TypeError)
  })

  it('rejects a negative visit value', () => {
    expect(() =>
      decideSkipCredit({
        reason: 'provider_unavailable',
        occurrenceValueCents: -1,
        serviceDate: TUESDAY,
      }),
    ).toThrow(RangeError)
  })
})

describe('totalCredit', () => {
  const credited = (cents: number): CreditDecision => ({
    credited: true,
    amountCents: cents,
    code: 'provider_did_not_deliver',
    message: '',
    noticeDays: null,
  })
  const refused: CreditDecision = {
    credited: false,
    amountCents: 0,
    code: 'customer_inside_cutoff',
    message: '',
    noticeDays: 0,
  }

  it('sums only what was actually credited', () => {
    expect(totalCredit([credited(300), refused, credited(300)])).toBe(600)
  })

  it('is zero for an empty cycle', () => {
    expect(totalCredit([])).toBe(0)
  })

  it('never returns a negative total', () => {
    expect(totalCredit([{ ...credited(-500) }])).toBe(0)
  })
})

describe('the default policy', () => {
  it('is one day, which is what the copy promises', () => {
    expect(DEFAULT_SKIP_POLICY.customerNoticeDays).toBe(1)
  })
})
