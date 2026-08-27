/**
 * Which step of provider onboarding a person is on.
 *
 * Pure. The facts come from the database, the decision comes from here, so
 * "what should this screen show" is answerable in a unit test rather than
 * only by clicking through with a real account.
 *
 * ## Order is not a preference
 *
 * Details, then guardian, then payouts. That sequence is forced by what
 * each step needs from the one before it: the date of birth decides whether
 * a guardian is required at all, and for a 13-17 provider it is the
 * guardian who legally holds the payout account, so there is nobody to send
 * to Stripe until the guardian relationship exists.
 *
 * ## Guardian clearance is not the same as being done
 *
 * A cleared guardian and a ready payout account are separate conditions and
 * both are required before a customer can pay. Collapsing them into one
 * "onboarded" boolean is how a provider ends up publishing a service they
 * cannot be paid for.
 */

import { isGuardianCleared, type GuardianState } from './guardian'

export type OnboardingStage =
  /** No provider profile yet. Needs a name and a date of birth. */
  | 'details'
  /** Under 18 and the guardian relationship is not cleared. */
  | 'guardian'
  /** Cleared to proceed, but the payout account is not ready. */
  | 'payouts'
  /** Everything required before taking a paying customer is in place. */
  | 'ready'

export type OnboardingFacts = {
  hasProviderProfile: boolean
  guardianState: GuardianState | null
  /** Stripe says this account can receive transfers and payouts. */
  payoutReady: boolean
}

export function onboardingStage(facts: OnboardingFacts): OnboardingStage {
  if (!facts.hasProviderProfile || facts.guardianState === null) return 'details'
  if (!isGuardianCleared(facts.guardianState)) return 'guardian'
  if (!facts.payoutReady) return 'payouts'
  return 'ready'
}

/**
 * A revoked guardian sends a provider back to the guardian step even if
 * their payouts were previously ready.
 *
 * SAFETY_TRUST_POLICY section 2: on revocation future charges stop. The
 * stage has to reflect that, or the dashboard would keep telling a provider
 * whose guardian has withdrawn consent that everything is fine.
 */
export function stageIsBlockedByGuardian(stage: OnboardingStage): boolean {
  return stage === 'guardian'
}

export type StepState = 'done' | 'current' | 'upcoming'

/**
 * The three steps and where the person is, for a progress display.
 *
 * `guardian` is absent entirely for an adult rather than shown as skipped.
 * A step labelled "not needed for you" on a page an adult provider sees is
 * a step that tells anyone reading over their shoulder something about
 * their age.
 */
export function onboardingSteps(args: {
  stage: OnboardingStage
  guardianRequired: boolean
}): Array<{ key: 'details' | 'guardian' | 'payouts'; label: string; state: StepState }> {
  const order: Array<{ key: 'details' | 'guardian' | 'payouts'; label: string }> = [
    { key: 'details', label: 'Your details' },
    ...(args.guardianRequired ? [{ key: 'guardian' as const, label: 'Guardian approval' }] : []),
    { key: 'payouts', label: 'Getting paid' },
  ]

  const position: Record<OnboardingStage, number> = {
    details: 0,
    guardian: 1,
    payouts: order.length - 1,
    ready: order.length,
  }
  const at = position[args.stage]

  return order.map((step, index) => ({
    ...step,
    state: index < at ? 'done' : index === at ? 'current' : 'upcoming',
  }))
}
