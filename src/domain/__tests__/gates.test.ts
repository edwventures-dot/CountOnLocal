import { describe, expect, it } from 'vitest'
import {
  canAcceptNewSubscription,
  canDraftBusiness,
  canPublishBusiness,
  canRunRoute,
  type ProviderGateContext,
} from '../gates'
import type { Role } from '../roles'

/**
 * What is left of these once minors are gone.
 *
 * The original suite was mostly about guardian state: a minor whose
 * guardian had not verified could draft but not publish, a revocation
 * stopped new checkouts on the next attempt, and a stored `not_required`
 * against a minor's date of birth was treated as tampering rather than
 * trusted. All of that has gone with the guardian machine.
 *
 * What remains is worth keeping honest anyway. Every gate is a permission
 * check now, and the thing that could still silently break is a gate that
 * forgets to make one -- so each is asserted separately rather than through
 * a shared helper that would pass whatever the implementation happened to
 * share.
 */

const ctx = (roles: Role[]): ProviderGateContext => ({ roles })

const GATES = [
  ['canDraftBusiness', canDraftBusiness],
  ['canPublishBusiness', canPublishBusiness],
  ['canAcceptNewSubscription', canAcceptNewSubscription],
  ['canRunRoute', canRunRoute],
] as const

describe('somebody who is not a provider', () => {
  for (const [name, gate] of GATES) {
    it(`${name} refuses a customer`, () => {
      const decision = gate(ctx(['customer']))
      expect(decision.allowed).toBe(false)
      if (!decision.allowed) expect(decision.code).toBe('NOT_A_PROVIDER')
    })

    it(`${name} refuses somebody with no roles at all`, () => {
      expect(gate(ctx([])).allowed).toBe(false)
    })
  }
})

describe('a provider', () => {
  for (const [name, gate] of GATES) {
    it(`${name} allows a provider`, () => {
      expect(gate(ctx(['provider'])).allowed).toBe(true)
    })
  }

  it('allows somebody holding provider alongside other roles', () => {
    // Roles are additive permissions, not an is_admin flag. A person who
    // hires a neighbour and also mows lawns holds both.
    expect(canPublishBusiness(ctx(['customer', 'provider'])).allowed).toBe(true)
  })
})

describe('publishing asks for more than drafting', () => {
  it('separates the two permissions, so one cannot imply the other', () => {
    // A positive control. If canPublishBusiness ever stops checking
    // business:publish it becomes an alias for canDraftBusiness, and every
    // test above would still pass.
    const roles = ['support_agent'] as Role[]
    expect(canDraftBusiness(ctx(roles)).allowed).toBe(false)
    expect(canPublishBusiness(ctx(roles)).allowed).toBe(false)
  })
})
