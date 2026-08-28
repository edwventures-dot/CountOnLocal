import { describe, expect, it } from 'vitest'
import {
  accountStanding,
  checkAccountAction,
  standingMessage,
  STRIKES_BEFORE_REVIEW,
  type AccountAction,
} from '../enforcement'

let clock = 0
const at = (kind: AccountAction['kind']): AccountAction => ({
  kind,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)).toISOString(),
})

describe('standing is derived from the history', () => {
  it('starts clean', () => {
    const s = accountStanding([])
    expect(s).toMatchObject({ strikes: 0, suspended: false, banned: false, status: 'active' })
  })

  it('counts strikes', () => {
    expect(accountStanding([at('strike'), at('strike')]).strikes).toBe(2)
  })

  it('does not suspend on strikes alone', () => {
    // A counter that acted on its own would suspend a provider whose
    // customer reported three visits in the week their grandmother died.
    const many = Array.from({ length: STRIKES_BEFORE_REVIEW + 2 }, () => at('strike'))
    const s = accountStanding(many)
    expect(s.suspended).toBe(false)
    expect(s.status).toBe('active')
  })

  it('recommends a human look once strikes reach the threshold', () => {
    const s = accountStanding(Array.from({ length: STRIKES_BEFORE_REVIEW }, () => at('strike')))
    expect(s.reviewRecommended).toBe(true)
  })

  it('stops recommending once somebody has acted', () => {
    const s = accountStanding([
      ...Array.from({ length: STRIKES_BEFORE_REVIEW }, () => at('strike')),
      at('suspend'),
    ])
    expect(s.reviewRecommended).toBe(false)
    expect(s.suspended).toBe(true)
  })

  it('reinstating clears the suspension and the strikes', () => {
    const s = accountStanding([at('strike'), at('strike'), at('suspend'), at('reinstate')])
    expect(s).toMatchObject({ strikes: 0, suspended: false, status: 'active' })
  })

  it('counts strikes earned after a reinstatement', () => {
    const s = accountStanding([at('strike'), at('reinstate'), at('strike')])
    expect(s.strikes).toBe(1)
  })

  it('does not let a reinstatement undo a ban', () => {
    // A ban is the end of the relationship. Undoing one should mean a
    // deliberate decision, not a row flipping back.
    const s = accountStanding([at('ban'), at('reinstate')])
    expect(s.banned).toBe(true)
    expect(s.suspended).toBe(true)
    expect(s.status).toBe('closed')
  })

  it('is order-independent of how the rows arrive', () => {
    const a = at('strike')
    const b = at('suspend')
    const c = at('reinstate')
    expect(accountStanding([c, a, b])).toEqual(accountStanding([a, b, c]))
  })
})

describe('refusing actions that would do nothing', () => {
  it('refuses suspending an already suspended account', () => {
    // An admin who sees "done" reasonably believes they changed something.
    const s = accountStanding([at('suspend')])
    expect(checkAccountAction(s, 'suspend').ok).toBe(false)
  })

  it('allows suspending an active one', () => {
    expect(checkAccountAction(accountStanding([]), 'suspend').ok).toBe(true)
  })

  it('refuses reinstating an account with nothing to reinstate', () => {
    expect(checkAccountAction(accountStanding([]), 'reinstate').ok).toBe(false)
  })

  it('allows reinstating a suspended one', () => {
    expect(checkAccountAction(accountStanding([at('suspend')]), 'reinstate').ok).toBe(true)
  })

  it('refuses everything on a banned account', () => {
    const banned = accountStanding([at('ban')])
    for (const kind of ['strike', 'suspend', 'ban', 'reinstate'] as const) {
      expect(checkAccountAction(banned, kind).ok, kind).toBe(false)
    }
  })

  it('says a ban must be escalated rather than silently allowing it', () => {
    const r = checkAccountAction(accountStanding([at('ban')]), 'reinstate')
    if (!r.ok) expect(r.message).toMatch(/escalate/i)
  })
})

describe('what the person is told', () => {
  it('says nothing when there is nothing to say', () => {
    expect(standingMessage(accountStanding([]))).toBeNull()
    expect(standingMessage(accountStanding([at('strike')]))).toBeNull()
  })

  it('explains a suspension', () => {
    expect(standingMessage(accountStanding([at('suspend')]))).toMatch(/suspended/i)
  })

  it('never names who reported it', () => {
    // A notice that names the reporter is a notice that gets somebody
    // shouted at over a fence.
    for (const actions of [[at('suspend')], [at('ban')]]) {
      const message = standingMessage(accountStanding(actions)) ?? ''
      expect(message).not.toMatch(/report(ed)? by|customer said|neighbou?r/i)
    }
  })
})
