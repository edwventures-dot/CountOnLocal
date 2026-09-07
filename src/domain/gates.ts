/**
 * Server-side gates.
 *
 * These compose roles into the decisions QA_ACCEPTANCE section 3 tests: may
 * this provider publish, and may this provider take on a new customer.
 *
 * Everything here is a pure function of stored state. Nothing accepts a
 * caller-supplied flag, because the whole point of a server-side gate is
 * that the client cannot answer the question on its own behalf.
 *
 * ## What these used to do
 *
 * In the full product every gate had a second half: a guardian state, read
 * live rather than cached, so that a guardian revoking consent stopped new
 * checkouts on the next attempt with no job to run. Four of the five gates
 * existed only to enforce that, and `guardianStateIsConsistent` existed to
 * catch a minor sitting at `not_required` -- a combination no legal
 * transition could produce, and therefore either tampering or a bug.
 *
 * With every provider an adult, all of that collapses into a permission
 * check. The functions are kept as separate named gates rather than
 * folded into one, because the callers ask genuinely different questions
 * and a branch that puts minors back would need the seams to still exist.
 */

import { hasPermission, type Role } from './roles'

export type ProviderGateContext = {
  roles: readonly Role[]
}

export type GateDenial = 'NOT_A_PROVIDER'

export type GateDecision = { allowed: true } | { allowed: false; code: GateDenial }

function baseProviderChecks(ctx: ProviderGateContext): GateDecision {
  if (!hasPermission(ctx.roles, 'business:draft')) {
    return { allowed: false, code: 'NOT_A_PROVIDER' }
  }
  return { allowed: true }
}

/** May this provider publish a publicly visible service? */
export function canPublishBusiness(ctx: ProviderGateContext): GateDecision {
  const base = baseProviderChecks(ctx)
  if (!base.allowed) return base
  if (!hasPermission(ctx.roles, 'business:publish')) {
    return { allowed: false, code: 'NOT_A_PROVIDER' }
  }
  return { allowed: true }
}

/** May a new customer subscribe to this provider right now? */
export function canAcceptNewSubscription(ctx: ProviderGateContext): GateDecision {
  return baseProviderChecks(ctx)
}

/** May this provider run their route -- complete stops, skip stops? */
export function canRunRoute(ctx: ProviderGateContext): GateDecision {
  return baseProviderChecks(ctx)
}

/** Drafting is always allowed for a provider. */
export function canDraftBusiness(ctx: ProviderGateContext): GateDecision {
  return baseProviderChecks(ctx)
}
