import { describe, expect, it } from 'vitest'
import {
  checkResponse,
  checkReviewContent,
  checkReviewEligibility,
  DEFAULT_MIN_REVIEWS_FOR_PUBLIC_RATING,
  isReportReason,
  publicRating,
  shouldHideOnReport,
} from '../review'
import type { PlainDate } from '../age'
import type { OccurrenceState } from '../occurrence'

const d = (y: number, m: number, day: number): PlainDate => ({ year: y, month: m, day })
const CYCLE = d(2026, 9, 1)

const base = {
  occurrenceState: 'completed' as OccurrenceState,
  subscriptionCustomerUserId: 'cust_1',
  actorUserId: 'cust_1',
  occurrenceAlreadyReviewed: false,
  cycleStart: CYCLE,
  reviewedCycleStarts: [] as PlainDate[],
}

describe('only delivered work can be reviewed', () => {
  it.each(['completed', 'settled'] as const)('allows a %s visit', (state) => {
    expect(checkReviewEligibility({ ...base, occurrenceState: state }).eligible).toBe(true)
  })

  it.each([
    'scheduled',
    'due_today',
    'started',
    'provider_skipped',
    'customer_skipped',
    'credited',
    'canceled',
  ] as const)('refuses a %s visit', (state) => {
    const r = checkReviewEligibility({ ...base, occurrenceState: state })
    expect(r.eligible).toBe(false)
    if (!r.eligible) expect(r.code).toBe('occurrence_not_delivered')
  })

  it('will not let a stranger review somebody else service', () => {
    const r = checkReviewEligibility({ ...base, actorUserId: 'someone_else' })
    expect(r.eligible).toBe(false)
    if (!r.eligible) expect(r.code).toBe('not_your_service')
  })

  it('checks ownership before delivery, so a stranger learns nothing', () => {
    // A stranger probing a scheduled visit gets "not yours", not "not
    // delivered yet" -- the second would confirm the visit exists.
    const r = checkReviewEligibility({
      ...base,
      actorUserId: 'stranger',
      occurrenceState: 'scheduled',
    })
    if (!r.eligible) expect(r.code).toBe('not_your_service')
  })
})

describe('one review per visit, one per cycle', () => {
  it('refuses a second review of the same visit', () => {
    const r = checkReviewEligibility({ ...base, occurrenceAlreadyReviewed: true })
    expect(r.eligible).toBe(false)
    if (!r.eligible) expect(r.code).toBe('already_reviewed')
  })

  it('refuses a second review in the same billing cycle', () => {
    const r = checkReviewEligibility({ ...base, reviewedCycleStarts: [CYCLE] })
    expect(r.eligible).toBe(false)
    if (!r.eligible) expect(r.code).toBe('cycle_already_reviewed')
  })

  it('allows one in the next cycle', () => {
    const r = checkReviewEligibility({
      ...base,
      cycleStart: d(2026, 9, 29),
      reviewedCycleStarts: [CYCLE],
    })
    expect(r.eligible).toBe(true)
  })

  it('does not block when the cycle is unknown', () => {
    expect(
      checkReviewEligibility({ ...base, cycleStart: null, reviewedCycleStarts: [CYCLE] }).eligible,
    ).toBe(true)
  })
})

describe('review content', () => {
  it.each([1, 2, 3, 4, 5])('accepts %i stars', (rating) => {
    const r = checkReviewContent({ rating })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.rating).toBe(rating)
  })

  it.each([0, 6, -1, 100])('refuses %i stars', (rating) => {
    expect(checkReviewContent({ rating }).ok).toBe(false)
  })

  it('refuses a fractional rating', () => {
    expect(checkReviewContent({ rating: 4.5 }).ok).toBe(false)
  })

  it('refuses a rating that is not a number', () => {
    expect(checkReviewContent({ rating: '5' }).ok).toBe(false)
    expect(checkReviewContent({ rating: null }).ok).toBe(false)
  })

  it('accepts stars with no text', () => {
    const r = checkReviewContent({ rating: 5 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.body).toBeNull()
  })

  it('treats whitespace-only text as no text', () => {
    const r = checkReviewContent({ rating: 5, body: '   ' })
    if (r.ok) expect(r.body).toBeNull()
  })

  it('trims what was written', () => {
    const r = checkReviewContent({ rating: 5, body: '  Always on time.  ' })
    if (r.ok) expect(r.body).toBe('Always on time.')
  })

  it('refuses an essay', () => {
    const r = checkReviewContent({ rating: 5, body: 'x'.repeat(1001) })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.field).toBe('body')
  })
})

describe('a minor has no public rating until there is a body of work', () => {
  it('shows nothing at all with one review', () => {
    const r = publicRating({ ratings: [5] })
    expect(r.visible).toBe(false)
    if (!r.visible) {
      expect(r.count).toBe(1)
      // Not "5.0 (1)". Not a rounded number. Nothing.
      expect(JSON.stringify(r)).not.toContain('average')
    }
  })

  it('shows nothing with one bad review either', () => {
    // The direction the rule really exists for.
    const r = publicRating({ ratings: [1] })
    expect(r.visible).toBe(false)
  })

  it('says how many more are needed', () => {
    const r = publicRating({ ratings: [5, 4] })
    if (!r.visible) expect(r.label).toContain('1 more review')
  })

  it('says "reviews" plural when more than one is needed', () => {
    const r = publicRating({ ratings: [5] })
    if (!r.visible) expect(r.label).toContain('2 more reviews')
  })

  it('says no reviews yet when there are none', () => {
    const r = publicRating({ ratings: [] })
    if (!r.visible) expect(r.label).toBe('No reviews yet')
  })

  it('appears at the threshold', () => {
    const r = publicRating({ ratings: [5, 4, 3] })
    expect(r.visible).toBe(true)
    if (r.visible) {
      expect(r.average).toBe(4)
      expect(r.count).toBe(3)
    }
  })

  it('uses the documented default of three', () => {
    expect(DEFAULT_MIN_REVIEWS_FOR_PUBLIC_RATING).toBe(3)
  })

  it('honours a market-specific threshold', () => {
    expect(publicRating({ ratings: [5, 4, 3], minimum: 5 }).visible).toBe(false)
    expect(publicRating({ ratings: [5], minimum: 1 }).visible).toBe(true)
  })

  it('rounds to one decimal the way a person would', () => {
    // 4 + 4 + 5 = 13 / 3 = 4.333...
    const r = publicRating({ ratings: [4, 4, 5] })
    if (r.visible) expect(r.average).toBe(4.3)
  })

  it('rounds a half up', () => {
    // 4 + 4 + 5 + 5 = 18 / 4 = 4.5
    const r = publicRating({ ratings: [4, 4, 5, 5] })
    if (r.visible) expect(r.average).toBe(4.5)
  })
})

describe('the provider gets one reply', () => {
  const base = {
    providerUserId: 'prov_1',
    actorUserId: 'prov_1',
    existingResponse: null as string | null,
  }

  it('accepts the first one', () => {
    const r = checkResponse({ ...base, body: 'Thanks! See you Tuesday.' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.body).toBe('Thanks! See you Tuesday.')
  })

  it('refuses a second', () => {
    const r = checkResponse({ ...base, body: 'Actually...', existingResponse: 'Thanks!' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('already_responded')
  })

  it('refuses somebody else provider', () => {
    const r = checkResponse({ ...base, actorUserId: 'other', body: 'Hi' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('not_your_review')
  })

  it('refuses an empty reply', () => {
    expect(checkResponse({ ...base, body: '   ' }).ok).toBe(false)
  })

  it('refuses an over-long one', () => {
    expect(checkResponse({ ...base, body: 'x'.repeat(1001) }).ok).toBe(false)
  })
})

describe('reporting', () => {
  it('recognises the reasons', () => {
    expect(isReportReason('harassment')).toBe(true)
    expect(isReportReason('personal_information')).toBe(true)
    expect(isReportReason('made_up')).toBe(false)
  })

  it('hides immediately for the reasons that cannot wait', () => {
    for (const reason of ['personal_information', 'harassment', 'sexual_content', 'threat'] as const) {
      expect(shouldHideOnReport(reason)).toBe(true)
    }
  })

  it('leaves an ordinary dispute visible for a human to judge', () => {
    // A provider disliking a review is not grounds for it to vanish.
    expect(shouldHideOnReport('not_about_this_service')).toBe(false)
    expect(shouldHideOnReport('spam_or_advertising')).toBe(false)
    expect(shouldHideOnReport('other')).toBe(false)
  })
})
