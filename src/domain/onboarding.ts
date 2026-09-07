/**
 * Which step of provider onboarding a person is on.
 *
 * Pure. The facts come from the database, the decision comes from here, so
 * "what should this screen show" is answerable in a unit test rather than
 * only by clicking through with a real account.
 *
 * ## What is left of it
 *
 * There were three steps: details, then guardian, then payouts. The order
 * was forced -- a date of birth decided whether a guardian was needed, and
 * for a 13-17 provider it was the guardian who legally held the payout
 * account, so there was nobody to send to Stripe until the guardian
 * existed.
 *
 * Both of the later steps are gone. Nobody needs a guardian, and nobody
 * gets paid through this product, so a provider who has filled in their
 * details is done. The stage is kept as a type rather than replaced with a
 * boolean because the screens still ask "where are they", and because a
 * one-step flow that has to grow back to two is easier from here than from
 * a boolean somebody has to unpick.
 */

export type OnboardingStage =
  /** No provider profile yet. Needs a name. */
  | 'details'
  /** Everything required before listing a service is in place. */
  | 'ready'

export type OnboardingFacts = {
  hasProviderProfile: boolean
}

export function onboardingStage(facts: OnboardingFacts): OnboardingStage {
  return facts.hasProviderProfile ? 'ready' : 'details'
}

export type StepState = 'done' | 'current' | 'upcoming'

export function onboardingSteps(args: {
  stage: OnboardingStage
}): Array<{ key: 'details'; label: string; state: StepState }> {
  return [
    {
      key: 'details',
      label: 'Your details',
      state: args.stage === 'ready' ? 'done' : 'current',
    },
  ]
}
