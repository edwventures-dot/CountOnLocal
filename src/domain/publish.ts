/**
 * Publish readiness.
 *
 * PRD section 8 ends the business creation flow at "Preview page. Publish."
 * Everything that must be true by then is gathered here, in one place, so a
 * future UI cannot publish by satisfying a different set of checks than the
 * API enforces.
 *
 * ## Two blockers went away
 *
 * There used to be a safety check before everything else -- a minor with no
 * verified guardian was told that first, rather than being walked through
 * filling in a service area they were not allowed to publish -- and a money
 * check after it, because publishing a page that cannot take payment wastes
 * the provider's flyer run and the customer's time.
 *
 * Neither applies now. Nobody needs a guardian and nothing takes payment,
 * so what is left is completeness: does this business actually describe a
 * service somebody could turn up for.
 */

export type PublishBlocker =
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

  if (input.businessState === 'published') return ['ALREADY_PUBLISHED']

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
