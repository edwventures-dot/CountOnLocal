import { describe, expect, it } from 'vitest'
import {
  ACTIONABLE_STATES,
  availableTransitions,
  canTransition,
  isTerminal,
  TRANSITIONS,
  wasDelivered,
  type Actor,
  type OccurrenceState,
} from '../occurrence'

const ALL_STATES: OccurrenceState[] = [
  'scheduled',
  'due_today',
  'started',
  'completed',
  'settled',
  'provider_skipped',
  'customer_skipped',
  'issue_reported',
  'credited',
  'canceled',
]

const ALL_ACTORS: Actor[] = ['provider', 'customer', 'system', 'admin']

describe('the happy path from PRD section 11', () => {
  it('runs scheduled -> due_today -> started -> completed -> settled', () => {
    expect(canTransition({ from: 'scheduled', to: 'due_today', actor: 'system' }).ok).toBe(true)
    expect(canTransition({ from: 'due_today', to: 'started', actor: 'provider' }).ok).toBe(true)
    expect(canTransition({ from: 'started', to: 'completed', actor: 'provider' }).ok).toBe(true)
    expect(canTransition({ from: 'completed', to: 'settled', actor: 'system' }).ok).toBe(true)
  })

  it('lets a provider complete without starting, because starting is optional', () => {
    expect(canTransition({ from: 'due_today', to: 'completed', actor: 'provider' }).ok).toBe(true)
  })
})

describe('provider and customer skips are not the same event', () => {
  it('only the provider can provider_skip', () => {
    expect(canTransition({ from: 'due_today', to: 'provider_skipped', actor: 'provider' }).ok).toBe(true)

    const asCustomer = canTransition({ from: 'due_today', to: 'provider_skipped', actor: 'customer' })
    expect(asCustomer.ok).toBe(false)
    if (!asCustomer.ok) expect(asCustomer.code).toBe('wrong_actor')
  })

  it('only the customer can customer_skip', () => {
    expect(canTransition({ from: 'scheduled', to: 'customer_skipped', actor: 'customer' }).ok).toBe(true)

    const asProvider = canTransition({ from: 'scheduled', to: 'customer_skipped', actor: 'provider' })
    expect(asProvider.ok).toBe(false)
    if (!asProvider.ok) expect(asProvider.code).toBe('wrong_actor')
  })

  it('a provider cannot skip on the customer behalf to avoid owing a credit', () => {
    // The whole reason the two states exist separately.
    expect(availableTransitions('due_today', 'provider')).not.toContain('customer_skipped')
  })
})

describe('refusals distinguish impossible from not-yours', () => {
  it('reports unknown_transition for an edge that does not exist', () => {
    const r = canTransition({ from: 'scheduled', to: 'settled', actor: 'system' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('unknown_transition')
      expect(r.message).toContain('scheduled')
    }
  })

  it('lists the real options in the message', () => {
    const r = canTransition({ from: 'scheduled', to: 'settled', actor: 'system' })
    if (!r.ok) {
      expect(r.message).toContain('due_today')
      expect(r.message).toContain('canceled')
    }
  })

  it('says a terminal state is final rather than listing nothing', () => {
    const r = canTransition({ from: 'credited', to: 'completed', actor: 'admin' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('final')
  })
})

describe('completed work cannot be quietly undone', () => {
  it('nobody can move completed back to scheduled or due_today', () => {
    for (const actor of ALL_ACTORS) {
      expect(canTransition({ from: 'completed', to: 'scheduled', actor }).ok).toBe(false)
      expect(canTransition({ from: 'completed', to: 'due_today', actor }).ok).toBe(false)
    }
  })

  it('a completed occurrence cannot be skipped after the fact', () => {
    for (const actor of ALL_ACTORS) {
      expect(canTransition({ from: 'completed', to: 'provider_skipped', actor }).ok).toBe(false)
      expect(canTransition({ from: 'completed', to: 'customer_skipped', actor }).ok).toBe(false)
    }
  })

  it('routes a post-completion dispute through issue_reported instead', () => {
    expect(canTransition({ from: 'completed', to: 'issue_reported', actor: 'customer' }).ok).toBe(true)
    expect(canTransition({ from: 'settled', to: 'issue_reported', actor: 'customer' }).ok).toBe(true)
  })
})

describe('incident resolution belongs to admin only', () => {
  it.each(['completed', 'credited', 'settled'] as const)(
    'lets admin resolve an issue to %s',
    (to) => {
      expect(canTransition({ from: 'issue_reported', to, actor: 'admin' }).ok).toBe(true)
    },
  )

  it('does not let the provider or customer resolve their own dispute', () => {
    for (const actor of ['provider', 'customer'] as const) {
      expect(canTransition({ from: 'issue_reported', to: 'completed', actor }).ok).toBe(false)
      expect(canTransition({ from: 'issue_reported', to: 'credited', actor }).ok).toBe(false)
    }
  })
})

describe('cancellation is not a skip', () => {
  it('cancels future work without anyone owing anything', () => {
    expect(canTransition({ from: 'scheduled', to: 'canceled', actor: 'system' }).ok).toBe(true)
    expect(canTransition({ from: 'due_today', to: 'canceled', actor: 'system' }).ok).toBe(true)
  })

  it('cannot cancel work that was already done', () => {
    for (const actor of ALL_ACTORS) {
      expect(canTransition({ from: 'completed', to: 'canceled', actor }).ok).toBe(false)
      expect(canTransition({ from: 'settled', to: 'canceled', actor }).ok).toBe(false)
    }
  })

  it('is a system action, not something a provider can do to dodge a credit', () => {
    expect(availableTransitions('scheduled', 'provider')).not.toContain('canceled')
  })
})

describe('classification helpers', () => {
  it('treats only credited and canceled as terminal', () => {
    expect(isTerminal('credited')).toBe(true)
    expect(isTerminal('canceled')).toBe(true)
    expect(isTerminal('settled')).toBe(false) // an issue can still be raised
    expect(isTerminal('scheduled')).toBe(false)
  })

  it('counts completed and settled as delivered, and nothing else', () => {
    for (const s of ALL_STATES) {
      expect(wasDelivered(s)).toBe(s === 'completed' || s === 'settled')
    }
  })

  it('puts exactly the day-of states on the route', () => {
    expect([...ACTIONABLE_STATES].sort()).toEqual(['due_today', 'started'])
  })
})

describe('the transition table itself', () => {
  it('has no duplicate edges', () => {
    const keys = TRANSITIONS.map((t) => `${t.from}->${t.to}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('gives every edge at least one actor and a note', () => {
    for (const t of TRANSITIONS) {
      expect(t.by.length).toBeGreaterThan(0)
      expect(t.note.length).toBeGreaterThan(10)
    }
  })

  it('never lets an occurrence transition to itself', () => {
    for (const t of TRANSITIONS) expect(t.from).not.toBe(t.to)
  })

  it('leaves every non-terminal state reachable from scheduled', () => {
    // Guards against adding a state nothing can ever produce.
    const seen = new Set<OccurrenceState>(['scheduled'])
    let grew = true
    while (grew) {
      grew = false
      for (const t of TRANSITIONS) {
        if (seen.has(t.from) && !seen.has(t.to)) {
          seen.add(t.to)
          grew = true
        }
      }
    }
    for (const s of ALL_STATES) expect(seen.has(s)).toBe(true)
  })
})
