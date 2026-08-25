/**
 * Server-side gates.
 *
 * These compose age, guardian state and roles into the two decisions that
 * QA_ACCEPTANCE section 3 tests: may this provider publish, and may this
 * provider take on a new paying customer.
 *
 * Everything here is a pure function of stored state. Nothing accepts a
 * caller-supplied age, guardian flag, or "isMinor" boolean, because
 * QA_ACCEPTANCE requires that a provider cannot remove a guardian
 * requirement "client-side or via API". The requirement is derived from the
 * date of birth on every evaluation, so there is no field to tamper with.
 */

import { classifyAge, decideProviderAge, type PlainDate } from './age.js'
import { guardianCapabilities, isGuardianCleared, type GuardianState } from './guardian.js'
import { hasPermission, type Role } from './roles.js'

export type ProviderGateContext = {
  roles: readonly Role[]
  /** Authoritative DOB from provider_profiles. Never from the request body. */
  dateOfBirth: PlainDate
  /** Stored guardian_relationships.state. */
  guardianState: GuardianState
  /** Today, as a calendar date. Injected so tests are not time-dependent. */
  today: PlainDate
}

export type GateDenial =
  | 'NOT_A_PROVIDER'
  | 'PROVIDER_INELIGIBLE'
  | 'GUARDIAN_APPROVAL_REQUIRED'
  | 'GUARDIAN_STATE_INCONSISTENT'

export type GateDecision =
  | { allowed: true }
  | { allowed: false; code: GateDenial }

/**
 * Detects a stored guardian state that contradicts the provider's actual
 * age -- a minor sitting at `not_required`. That combination cannot arise
 * from any legal transition, so if it is in the database it is either
 * tampering or a bug. Either way the safe answer is to refuse and let a
 * human look, never to trust the stored value over the DOB.
 */
export function guardianStateIsConsistent(ctx: ProviderGateContext): boolean {
  const band = classifyAge(ctx.dateOfBirth, ctx.today)
  if (band === 'minor' && ctx.guardianState === 'not_required') return false
  return true
}

function baseProviderChecks(ctx: ProviderGateContext): GateDecision {
  if (!hasPermission(ctx.roles, 'business:draft')) {
    return { allowed: false, code: 'NOT_A_PROVIDER' }
  }
  const age = decideProviderAge(ctx.dateOfBirth, ctx.today)
  if (!age.allowed) return { allowed: false, code: 'PROVIDER_INELIGIBLE' }
  if (!guardianStateIsConsistent(ctx)) {
    return { allowed: false, code: 'GUARDIAN_STATE_INCONSISTENT' }
  }
  return { allowed: true }
}

/** May this provider publish a paid, publicly visible service? */
export function canPublishBusiness(ctx: ProviderGateContext): GateDecision {
  const base = baseProviderChecks(ctx)
  if (!base.allowed) return base
  if (!hasPermission(ctx.roles, 'business:publish')) {
    return { allowed: false, code: 'NOT_A_PROVIDER' }
  }
  if (!guardianCapabilities(ctx.guardianState).canPublishPaidService) {
    return { allowed: false, code: 'GUARDIAN_APPROVAL_REQUIRED' }
  }
  return { allowed: true }
}

/**
 * May a new customer subscribe to this provider right now?
 *
 * QA_ACCEPTANCE section 3: "Revocation immediately prevents new checkout."
 * Because this reads live guardian state rather than a cached publish flag,
 * a revocation takes effect on the next checkout attempt with no job to run
 * and no cache to bust.
 */
export function canAcceptNewSubscription(ctx: ProviderGateContext): GateDecision {
  const base = baseProviderChecks(ctx)
  if (!base.allowed) return base
  if (!guardianCapabilities(ctx.guardianState).canAcceptNewSubscriptions) {
    return { allowed: false, code: 'GUARDIAN_APPROVAL_REQUIRED' }
  }
  return { allowed: true }
}

/**
 * May the billing job charge this provider's existing subscribers on their
 * next cycle? SAFETY_TRUST_POLICY section 2: on revocation "future charges
 * stop", while already-paid pending occurrences are handed to support and
 * the guardian for resolution rather than being silently dropped.
 */
export function canContinueRecurringCharges(ctx: ProviderGateContext): GateDecision {
  const base = baseProviderChecks(ctx)
  if (!base.allowed) return base
  if (!guardianCapabilities(ctx.guardianState).canContinueRecurringCharges) {
    return { allowed: false, code: 'GUARDIAN_APPROVAL_REQUIRED' }
  }
  return { allowed: true }
}

/** Drafting is always allowed for an eligible provider, cleared or not. */
export function canDraftBusiness(ctx: ProviderGateContext): GateDecision {
  return baseProviderChecks(ctx)
}

export { isGuardianCleared }
