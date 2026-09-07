import { describe, expect, it } from 'vitest'
import { onboardingStage, onboardingSteps } from '../onboarding'

/**
 * Onboarding is one step now.
 *
 * The original suite tested the ordering of three: details, then guardian,
 * then payouts, with a revoked guardian sending somebody back a step even
 * if their payouts were already ready. Two of those steps are gone.
 *
 * Kept rather than deleted because the remaining behaviour is still a real
 * decision -- "has this person finished setting up" is what the dashboard
 * renders from -- and because a one-step flow is exactly the kind of thing
 * that gets quietly replaced by a boolean nobody tests.
 */

describe('where somebody is in onboarding', () => {
  it('starts at details with no profile', () => {
    expect(onboardingStage({ hasProviderProfile: false })).toBe('details')
  })

  it('is ready once the profile exists', () => {
    expect(onboardingStage({ hasProviderProfile: true })).toBe('ready')
  })
})

describe('the progress display', () => {
  it('shows the one step as current before it is done', () => {
    const steps = onboardingSteps({ stage: 'details' })
    expect(steps).toHaveLength(1)
    expect(steps[0]?.key).toBe('details')
    expect(steps[0]?.state).toBe('current')
  })

  it('shows it as done afterwards', () => {
    const steps = onboardingSteps({ stage: 'ready' })
    expect(steps[0]?.state).toBe('done')
  })

  it('never returns a step with no label', () => {
    // A blank label renders as an empty bullet, which reads as a broken
    // page rather than a missing string.
    for (const stage of ['details', 'ready'] as const) {
      for (const step of onboardingSteps({ stage })) {
        expect(step.label.trim().length).toBeGreaterThan(0)
      }
    }
  })
})
