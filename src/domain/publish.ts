/**
 * Publish readiness.
 *
 * PRD section 8 ends the business creation flow at "Preview page. Publish."
 * Everything that must be true by then is gathered here, in one place, so a
 * future UI cannot publish by satisfying a different set of checks than the
 * API enforces.
 *
 * The ordering matters: safety before completeness. A minor without a
 * verified guardian is told that first, rather than being walked through
 * filling in a service area they are not yet allowed to publish.
 */

import type { AgeBand } from './age'
import { isGuardianCleared, type GuardianState } from './guardian'
import { isPayoutReady, type StripeAccountState } from './payout'

export type PublishBlocker =
  | 'PROVIDER_INELIGIBLE'
  | 'GUARDIAN_APPROVAL_REQUIRED'
  | 'PAYOUT_ONBOARDING_INCOMPLETE'
  | 'NO_ACTIVE_SERVICE'
  | 'SERVICE_MISSING_AREA'
  | 'SERVICE_MISSING_SCHEDULE'
  | 'BUSINESS_MISSING_AREA_LABEL'
  | 'ALREADY_PUBLISHED'

export type ServiceReadiness = {
  id: string
  state: 'draft' | 'active' | 'paused'
  hasServiceArea: boolean
  hasSchedule: boolean
  priceCents: number
}

export type PublishInput = {
  band: AgeBand
  guardianState: GuardianState
  account: StripeAccountState
  businessState: string
  publicAreaLabel: string | null
  services: readonly ServiceReadiness[]
}

export type PublishDecision =
  | { allowed: true }
  | { allowed: false; blockers: readonly PublishBlocker[] }

/**
 * Every reason a business cannot go live, in the order a provider should be
 * told about them.
 *
 * Returns all blockers rather than the first, so the UI can show a checklist
 * instead of revealing one problem per attempt.
 */
export function publishBlockers(input: PublishInput): PublishBlocker[] {
  const blockers: PublishBlocker[] = []

  if (input.band === 'under_min_age') return ['PROVIDER_INELIGIBLE']

  if (input.businessState === 'published') return ['ALREADY_PUBLISHED']

  // Safety first.
  if (!isGuardianCleared(input.guardianState)) blockers.push('GUARDIAN_APPROVAL_REQUIRED')

  // Then money: publishing a page that cannot take payment wastes the
  // provider's flyer run and the customer's time.
  if (!isPayoutReady(input.account)) blockers.push('PAYOUT_ONBOARDING_INCOMPLETE')

  // Then completeness.
  const active = input.services.filter((s) => s.state === 'active')
  if (active.length === 0) {
    blockers.push('NO_ACTIVE_SERVICE')
  } else {
    if (active.some((s) => !s.hasServiceArea)) blockers.push('SERVICE_MISSING_AREA')
    if (active.some((s) => !s.hasSchedule)) blockers.push('SERVICE_MISSING_SCHEDULE')
  }

  if (!input.publicAreaLabel || input.publicAreaLabel.trim().length === 0) {
    blockers.push('BUSINESS_MISSING_AREA_LABEL')
  }

  return blockers
}

export function canPublish(input: PublishInput): PublishDecision {
  const blockers = publishBlockers(input)
  return blockers.length === 0 ? { allowed: true } : { allowed: false, blockers }
}
