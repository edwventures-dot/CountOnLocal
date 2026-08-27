import { describe, expect, it } from 'vitest'
import { onboardingStage, onboardingSteps, stageIsBlockedByGuardian } from '../onboarding'
import type { GuardianState } from '../guardian'

const facts = (over: Partial<Parameters<typeof onboardingStage>[0]> = {}) => ({
  hasProviderProfile: true,
  guardianState: 'not_required' as GuardianState,
  payoutReady: true,
  ...over,
})

describe('which step', () => {
  it('starts at details with no profile', () => {
    expect(onboardingStage(facts({ hasProviderProfile: false, guardianState: null }))).toBe('details')
  })

  it('sends an adult straight to payouts', () => {
    expect(onboardingStage(facts({ guardianState: 'not_required', payoutReady: false }))).toBe(
      'payouts',
    )
  })

  it('is ready when guardian and payouts both hold', () => {
    expect(onboardingStage(facts())).toBe('ready')
  })

  it.each<GuardianState>(['required_uninvited', 'invited', 'guardian_started', 'manual_review'])(
    'holds a minor at the guardian step in %s',
    (state) => {
      expect(onboardingStage(facts({ guardianState: state, payoutReady: true }))).toBe('guardian')
    },
  )

  it('lets a verified minor through to payouts', () => {
    expect(onboardingStage(facts({ guardianState: 'verified', payoutReady: false }))).toBe('payouts')
  })

  it('sends a revoked provider back to the guardian step even with payouts ready', () => {
    // SAFETY_TRUST_POLICY section 2: on revocation future charges stop. A
    // dashboard that kept saying "all set" would be lying to a provider
    // whose guardian has withdrawn consent.
    const stage = onboardingStage(facts({ guardianState: 'revoked', payoutReady: true }))
    expect(stage).toBe('guardian')
    expect(stageIsBlockedByGuardian(stage)).toBe(true)
  })

  it('does the same for an expired relationship', () => {
    expect(onboardingStage(facts({ guardianState: 'expired', payoutReady: true }))).toBe('guardian')
  })

  it('never reports ready on an uncleared guardian, whatever payouts say', () => {
    const uncleared: GuardianState[] = [
      'required_uninvited',
      'invited',
      'guardian_started',
      'revoked',
      'expired',
      'manual_review',
    ]
    for (const state of uncleared) {
      for (const payoutReady of [true, false]) {
        expect(onboardingStage(facts({ guardianState: state, payoutReady })), state).not.toBe('ready')
      }
    }
  })

  it('never reports ready without payouts, whatever the guardian says', () => {
    for (const state of ['not_required', 'verified'] as GuardianState[]) {
      expect(onboardingStage(facts({ guardianState: state, payoutReady: false }))).toBe('payouts')
    }
  })
})

describe('the progress display', () => {
  it('omits the guardian step entirely for an adult', () => {
    // Not "skipped" or "not needed for you" -- a step labelled that way on
    // an adult's screen tells anyone reading over their shoulder something
    // about their age.
    const steps = onboardingSteps({ stage: 'payouts', guardianRequired: false })
    expect(steps.map((s) => s.key)).toEqual(['details', 'payouts'])
  })

  it('includes it for a minor', () => {
    const steps = onboardingSteps({ stage: 'guardian', guardianRequired: true })
    expect(steps.map((s) => s.key)).toEqual(['details', 'guardian', 'payouts'])
  })

  it('marks earlier steps done and later ones upcoming', () => {
    const steps = onboardingSteps({ stage: 'guardian', guardianRequired: true })
    expect(steps.map((s) => s.state)).toEqual(['done', 'current', 'upcoming'])
  })

  it('marks everything done when ready', () => {
    const steps = onboardingSteps({ stage: 'ready', guardianRequired: true })
    expect(steps.every((s) => s.state === 'done')).toBe(true)
  })

  it('puts an adult on payouts as the last step', () => {
    const steps = onboardingSteps({ stage: 'payouts', guardianRequired: false })
    expect(steps.map((s) => s.state)).toEqual(['done', 'current'])
  })

  it('shows details as current at the very start', () => {
    const steps = onboardingSteps({ stage: 'details', guardianRequired: false })
    expect(steps[0]!.state).toBe('current')
  })
})
