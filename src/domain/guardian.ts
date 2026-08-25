/**
 * Guardian relationship state machine.
 *
 * SAFETY_TRUST_POLICY section 2 names the eight states. It specifies the
 * revocation behaviour precisely but does not publish a full transition
 * table, so the edges below are an implementation proposal. Transitions
 * marked INFERRED are ours, not the design document's, and are the ones to
 * argue about in review -- see the note at the bottom of this file.
 *
 * The rule that matters: guardian state is not a boolean. A minor provider
 * may draft freely in any state, but publishing a paid service and
 * accepting money are gated on `verified`, and only on `verified`.
 */

import type { AgeBand } from './age.js'

export type GuardianState =
  | 'not_required'
  | 'required_uninvited'
  | 'invited'
  | 'guardian_started'
  | 'verified'
  | 'revoked'
  | 'expired'
  | 'manual_review'

export type GuardianEvent =
  | 'INVITE'
  | 'RESEND_INVITE'
  | 'GUARDIAN_OPENED'
  | 'VERIFY'
  | 'REVOKE'
  | 'EXPIRE'
  | 'FLAG_FOR_REVIEW'
  | 'REVIEW_APPROVE'
  | 'REVIEW_DENY'
  | 'AGED_OUT'

const TRANSITIONS: Readonly<Record<GuardianState, Partial<Record<GuardianEvent, GuardianState>>>> = {
  // An adult provider needs no guardian. AGED_OUT is the only way in, and
  // there is no way out: age does not run backwards.
  not_required: {},

  required_uninvited: {
    INVITE: 'invited',
    FLAG_FOR_REVIEW: 'manual_review',
    AGED_OUT: 'not_required',
  },

  invited: {
    GUARDIAN_OPENED: 'guardian_started',
    RESEND_INVITE: 'invited',
    EXPIRE: 'expired',
    FLAG_FOR_REVIEW: 'manual_review',
    AGED_OUT: 'not_required',
  },

  guardian_started: {
    VERIFY: 'verified',
    EXPIRE: 'expired',
    FLAG_FOR_REVIEW: 'manual_review',
    AGED_OUT: 'not_required',
  },

  verified: {
    REVOKE: 'revoked',
    FLAG_FOR_REVIEW: 'manual_review',
    AGED_OUT: 'not_required',
  },

  // INFERRED: a revoked relationship can be restarted with a new invitation.
  // A guardian who revokes in anger on Tuesday may consent again on Friday,
  // and forcing account deletion to recover would be worse for the minor.
  revoked: {
    INVITE: 'invited',
    FLAG_FOR_REVIEW: 'manual_review',
    AGED_OUT: 'not_required',
  },

  expired: {
    INVITE: 'invited',
    FLAG_FOR_REVIEW: 'manual_review',
    AGED_OUT: 'not_required',
  },

  manual_review: {
    REVIEW_APPROVE: 'verified',
    REVIEW_DENY: 'revoked',
    AGED_OUT: 'not_required',
  },
}

export type TransitionResult =
  | { ok: true; from: GuardianState; to: GuardianState; event: GuardianEvent }
  | { ok: false; from: GuardianState; event: GuardianEvent; code: 'ILLEGAL_GUARDIAN_TRANSITION' }

/**
 * Pure transition. Never throws and never mutates: an illegal edge is a
 * value the caller can log and reject, not an exception to swallow.
 */
export function transition(from: GuardianState, event: GuardianEvent): TransitionResult {
  const to = TRANSITIONS[from][event]
  if (to === undefined) return { ok: false, from, event, code: 'ILLEGAL_GUARDIAN_TRANSITION' }
  return { ok: true, from, to, event }
}

/** Starting state implied by the provider's age band at onboarding. */
export function initialGuardianState(band: Exclude<AgeBand, 'under_min_age'>): GuardianState {
  return band === 'adult' ? 'not_required' : 'required_uninvited'
}

export type GuardianCapabilities = {
  /** Drafting is always permitted -- SAFETY_TRUST_POLICY section 2. */
  canDraftBusiness: boolean
  /** Publish a paid, publicly visible service. */
  canPublishPaidService: boolean
  /** Accept a new customer subscription. */
  canAcceptNewSubscriptions: boolean
  /** Continue charging existing subscriptions on their next cycle. */
  canContinueRecurringCharges: boolean
}

const CLEARED: ReadonlySet<GuardianState> = new Set<GuardianState>(['not_required', 'verified'])

/**
 * What a provider may do in a given guardian state.
 *
 * Everything that touches money or public visibility collapses to the same
 * question -- is the relationship cleared -- which is deliberate. Splitting
 * these into independently tunable flags is how a future edit accidentally
 * lets a revoked minor keep billing.
 */
export function guardianCapabilities(state: GuardianState): GuardianCapabilities {
  const cleared = CLEARED.has(state)
  return {
    canDraftBusiness: true,
    canPublishPaidService: cleared,
    canAcceptNewSubscriptions: cleared,
    canContinueRecurringCharges: cleared,
  }
}

export function isGuardianCleared(state: GuardianState): boolean {
  return CLEARED.has(state)
}

/**
 * Message shown to the provider. SAFETY_TRUST_POLICY section 2 limits what
 * a provider may be told about guardian status to exactly this much -- no
 * detail about what the guardian did, said, or failed to verify.
 */
export const PROVIDER_FACING_GUARDIAN_BLOCK = 'Guardian approval is required to continue.'

/**
 * OPEN QUESTION for owner review, per CLAUDE.md ("surface rather than
 * guess" on guardian state):
 *
 * AGED_OUT is modelled as available from every state, including `revoked`.
 * So a 17-year-old whose guardian revoked consent becomes unblocked on
 * their eighteenth birthday. That is legally coherent -- the guardian
 * requirement exists because of minority, and minority ends -- but it means
 * a revocation motivated by a safety concern silently stops applying on a
 * birthday. The alternative is routing aged-out-while-revoked through
 * `manual_review` so a human closes it out. This needs a product decision
 * before launch; the current edge is the permissive one.
 */
