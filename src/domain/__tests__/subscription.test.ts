import { describe, expect, it } from 'vitest'
import {
  canMoveSubscription,
  planEnding,
  LIVE_SUBSCRIPTION_STATES,
  SUBSCRIPTION_EDGES,
  TERMINAL_SUBSCRIPTION_STATES,
  type ReleasableOccurrence,
  type SubscriptionActor,
  type SubscriptionState,
} from '../subscription'
import { isoDate } from '../schedule'
import type { PlainDate } from '../age'

const d = (y: number, m: number, day: number): PlainDate => ({ year: y, month: m, day })
const TODAY = d(2026, 9, 10)

const ALL_STATES: SubscriptionState[] = [
  'pending',
  'active',
  'paused',
  'payment_failed',
  'canceled',
  'ended',
]
const ALL_ACTORS: SubscriptionActor[] = ['customer', 'provider', 'system', 'admin']

/** $3 visit on a 4-visit cycle at 15%: 45 cents of fee share. */
function occ(
  id: string,
  state: ReleasableOccurrence['state'],
  day: number,
): ReleasableOccurrence {
  return {
    id,
    state,
    serviceDate: d(2026, 9, day),
    valueCents: 300,
    feeShareCents: 45,
  }
}

describe('cancellation is self-service', () => {
  it('lets the customer cancel from every live state', () => {
    for (const from of ['pending', 'active', 'paused', 'payment_failed'] as const) {
      expect(canMoveSubscription({ from, to: 'canceled', actor: 'customer' }).ok).toBe(true)
    }
  })

  it('never requires an admin to do it', () => {
    // PRD section 16: no "contact support to cancel" dark pattern. If this
    // ever fails, someone has made cancelling a staff-only action.
    const customerCanCancel = SUBSCRIPTION_EDGES.filter(
      (e) => e.to === 'canceled' && e.by.includes('customer'),
    )
    expect(customerCanCancel.length).toBeGreaterThanOrEqual(4)
  })
})

describe('the state machine', () => {
  it('lets a customer pause and resume', () => {
    expect(canMoveSubscription({ from: 'active', to: 'paused', actor: 'customer' }).ok).toBe(true)
    expect(canMoveSubscription({ from: 'paused', to: 'active', actor: 'customer' }).ok).toBe(true)
  })

  it('does not let a provider pause or cancel their customer subscription', () => {
    expect(canMoveSubscription({ from: 'active', to: 'paused', actor: 'provider' }).ok).toBe(false)
    expect(canMoveSubscription({ from: 'active', to: 'canceled', actor: 'provider' }).ok).toBe(false)
  })

  it('never revives a cancelled subscription', () => {
    for (const to of ALL_STATES) {
      for (const actor of ALL_ACTORS) {
        expect(canMoveSubscription({ from: 'canceled', to, actor }).ok).toBe(false)
      }
    }
  })

  it('never revives an ended one either', () => {
    for (const to of ALL_STATES) {
      for (const actor of ALL_ACTORS) {
        expect(canMoveSubscription({ from: 'ended', to, actor }).ok).toBe(false)
      }
    }
  })

  it('says a terminal state is final rather than listing nothing', () => {
    const r = canMoveSubscription({ from: 'canceled', to: 'active', actor: 'admin' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('final')
  })

  it('separates a wrong actor from an impossible move', () => {
    const wrongActor = canMoveSubscription({ from: 'active', to: 'paused', actor: 'system' })
    expect(wrongActor.ok).toBe(false)
    if (!wrongActor.ok) expect(wrongActor.code).toBe('wrong_actor')

    const impossible = canMoveSubscription({ from: 'pending', to: 'paused', actor: 'customer' })
    expect(impossible.ok).toBe(false)
    if (!impossible.ok) expect(impossible.code).toBe('unknown_transition')
  })

  it('has no duplicate or self edges', () => {
    const keys = SUBSCRIPTION_EDGES.map((e) => `${e.from}->${e.to}`)
    expect(new Set(keys).size).toBe(keys.length)
    for (const e of SUBSCRIPTION_EDGES) expect(e.from).not.toBe(e.to)
  })

  it('classifies live and terminal states without overlap', () => {
    for (const s of ALL_STATES) {
      const live = LIVE_SUBSCRIPTION_STATES.has(s)
      const terminal = TERMINAL_SUBSCRIPTION_STATES.has(s)
      expect(live && terminal).toBe(false)
      expect(live || terminal).toBe(true)
    }
  })
})

describe('releasing the rest of a paid cycle', () => {
  it('releases future scheduled visits', () => {
    const plan = planEnding({
      occurrences: [occ('a', 'scheduled', 15), occ('b', 'scheduled', 22)],
      today: TODAY,
      standingCreditCents: 0,
      ending: 'cancel',
    })
    expect(plan.released.map((r) => r.occurrenceId)).toEqual(['a', 'b'])
  })

  it('leaves completed work completed', () => {
    // Ending a subscription does not unpay for work somebody did.
    const plan = planEnding({
      occurrences: [occ('done', 'completed', 3), occ('future', 'scheduled', 17)],
      today: TODAY,
      standingCreditCents: 0,
      ending: 'cancel',
    })
    expect(plan.released.map((r) => r.occurrenceId)).toEqual(['future'])
    expect(plan.untouched).toContain('done')
  })

  it('leaves a past-dated visit alone even if it was never resolved', () => {
    const plan = planEnding({
      occurrences: [occ('stale', 'due_today', 3)],
      today: TODAY,
      standingCreditCents: 0,
      ending: 'cancel',
    })
    expect(plan.released).toHaveLength(0)
    expect(plan.untouched).toEqual(['stale'])
  })

  it('leaves already-credited visits alone', () => {
    const plan = planEnding({
      occurrences: [occ('c', 'credited', 15)],
      today: TODAY,
      standingCreditCents: 0,
      ending: 'cancel',
    })
    expect(plan.released).toHaveLength(0)
  })

  it('credits service plus the fee the customer actually paid', () => {
    const plan = planEnding({
      occurrences: [occ('a', 'scheduled', 15)],
      today: TODAY,
      standingCreditCents: 0,
      ending: 'cancel',
    })
    expect(plan.newCreditCents).toBe(345)
  })

  it('applies the notice rule -- today visit is inside the cutoff', () => {
    const plan = planEnding({
      occurrences: [occ('today', 'due_today', 10)],
      today: TODAY,
      standingCreditCents: 0,
      ending: 'cancel',
    })
    expect(plan.released).toHaveLength(1)
    expect(plan.released[0]!.credit.credited).toBe(false)
    expect(plan.newCreditCents).toBe(0)
  })

  it('is not a back door around the notice rule', () => {
    // Cancelling on the day gives exactly what skipping on the day gives.
    const cancelling = planEnding({
      occurrences: [occ('x', 'due_today', 10)],
      today: TODAY,
      standingCreditCents: 0,
      ending: 'cancel',
    })
    expect(cancelling.released[0]!.credit.code).toBe('customer_inside_cutoff')
  })

  it('honours a stricter service policy', () => {
    const plan = planEnding({
      occurrences: [occ('a', 'scheduled', 11)], // one day out
      today: TODAY,
      standingCreditCents: 0,
      policy: { customerNoticeDays: 3 },
      ending: 'cancel',
    })
    expect(plan.released[0]!.credit.credited).toBe(false)
  })
})

describe('what is refundable', () => {
  it('refunds standing credit plus what cancelling released', () => {
    const plan = planEnding({
      occurrences: [occ('a', 'scheduled', 15)],
      today: TODAY,
      standingCreditCents: 345,
      ending: 'cancel',
    })
    expect(plan.refundableCents).toBe(345 + 345)
  })

  it('refunds nothing on a pause, because a pause may resume', () => {
    const plan = planEnding({
      occurrences: [occ('a', 'scheduled', 15)],
      today: TODAY,
      standingCreditCents: 345,
      ending: 'pause',
    })
    expect(plan.refundableCents).toBe(0)
    // The credit still exists -- it is just not being handed back yet.
    expect(plan.newCreditCents).toBe(345)
  })

  it('refunds standing credit even when nothing is left to release', () => {
    const plan = planEnding({
      occurrences: [],
      today: TODAY,
      standingCreditCents: 500,
      ending: 'cancel',
    })
    expect(plan.refundableCents).toBe(500)
  })

  it('refunds nothing when there is nothing owed', () => {
    const plan = planEnding({
      occurrences: [occ('today', 'due_today', 10)],
      today: TODAY,
      standingCreditCents: 0,
      ending: 'cancel',
    })
    expect(plan.refundableCents).toBe(0)
  })

  it('rejects a nonsense standing credit', () => {
    expect(() =>
      planEnding({ occurrences: [], today: TODAY, standingCreditCents: -1, ending: 'cancel' }),
    ).toThrow(RangeError)
  })
})

describe('effective date', () => {
  it('takes effect today -- no waiting period to cancel', () => {
    const plan = planEnding({
      occurrences: [],
      today: TODAY,
      standingCreditCents: 0,
      ending: 'cancel',
    })
    expect(isoDate(plan.effectiveFrom)).toBe('2026-09-10')
  })
})
