import { describe, it, expect } from 'vitest'
import { checkSlug, slugify, uniqueSlug, RESERVED_SLUGS } from '../slug'
import { canOfferService, flagProhibitedWording, type CatalogService } from '../catalog'
import { publishBlockers, canPublish, type ServiceReadiness } from '../publish'
import type { StripeAccountState } from '../payout'

describe('slugs', () => {
  it('derives a readable slug from a business name', () => {
    expect(slugify("Jake's Bin Service")).toBe('jakes-bin-service')
    expect(slugify('  Trey  Lawn   Care  ')).toBe('trey-lawn-care')
  })

  it('keeps accented letters instead of dropping them', () => {
    // "Café" losing its last letter would be a worse slug than transliterating.
    expect(slugify('Jorge Yard Café')).toBe('jorge-yard-cafe')
  })

  it('never produces a leading or trailing hyphen', () => {
    expect(slugify('!!! Bins !!!')).toBe('bins')
    expect(slugify('-- hello --')).toBe('hello')
  })

  it('rejects reserved slugs', () => {
    for (const s of ['admin', 'api', 'checkout', 'countonlocal']) {
      expect(checkSlug(s)).toEqual({ ok: false, code: 'RESERVED' })
    }
  })

  it('rejects malformed slugs', () => {
    expect(checkSlug('ab')).toEqual({ ok: false, code: 'TOO_SHORT' })
    expect(checkSlug('a'.repeat(41))).toEqual({ ok: false, code: 'TOO_LONG' })
    expect(checkSlug('Jakes-Bins')).toEqual({ ok: false, code: 'INVALID_CHARACTERS' })
    expect(checkSlug('jakes--bins')).toEqual({ ok: false, code: 'INVALID_CHARACTERS' })
    expect(checkSlug('-jakes')).toEqual({ ok: false, code: 'INVALID_CHARACTERS' })
  })

  it('rejects a slug shaped like an id', () => {
    expect(checkSlug('a1b2c3d4-e5f6-jakes')).toEqual({ ok: false, code: 'LOOKS_LIKE_A_UUID' })
  })

  it('accepts a normal business slug', () => {
    expect(checkSlug('jakes-bin-service')).toEqual({ ok: true })
  })

  describe('collision handling', () => {
    it('returns the base slug when free', () => {
      expect(uniqueSlug("Jake's Bin Service", new Set())).toBe('jakes-bin-service')
    })

    it('suffixes readably rather than randomly', () => {
      // The provider says this out loud to neighbours.
      const taken = new Set(['jakes-bin-service', 'jakes-bin-service-2'])
      expect(uniqueSlug("Jake's Bin Service", taken)).toBe('jakes-bin-service-3')
    })

    it('avoids reserved slugs even when derived from the name', () => {
      const s = uniqueSlug('Admin', new Set())
      expect(RESERVED_SLUGS.has(s)).toBe(false)
      expect(checkSlug(s).ok).toBe(true)
    })

    it('stays within the length limit when suffixing', () => {
      const long = 'a'.repeat(40)
      const taken = new Set([long])
      const s = uniqueSlug(long, taken)
      expect(s.length).toBeLessThanOrEqual(40)
      expect(checkSlug(s).ok).toBe(true)
    })

    it('falls back to a usable slug for an unusable name', () => {
      expect(uniqueSlug('!!!', new Set())).toBe('my-business')
    })
  })
})

const tierA: CatalogService = {
  id: 'cat-a',
  code: 'bin_curb_service',
  name: 'Bins',
  riskTier: 'A',
  minProviderAge: 13,
  guardianExplicitApproval: false,
  active: true,
}
const tierB: CatalogService = { ...tierA, id: 'cat-b', code: 'dog_walking', riskTier: 'B', guardianExplicitApproval: true }
const tierC: CatalogService = { ...tierA, id: 'cat-c', code: 'future_adult', riskTier: 'C', minProviderAge: 18 }
const tierX: CatalogService = { ...tierA, id: 'cat-x', code: 'prohibited', riskTier: 'X', active: false }

describe('catalog eligibility', () => {
  it('lets a verified minor offer a Tier A service', () => {
    expect(
      canOfferService({
        service: tierA,
        ageInYears: 14,
        band: 'minor',
        guardianState: 'verified',
        guardianApprovedCodes: [],
      }),
    ).toEqual({ allowed: true })
  })

  it('requires explicit guardian approval of the category for Tier B', () => {
    // A parent who agreed to bin service has not agreed to dog walking.
    expect(
      canOfferService({
        service: tierB,
        ageInYears: 14,
        band: 'minor',
        guardianState: 'verified',
        guardianApprovedCodes: ['bin_curb_service'],
      }),
    ).toEqual({ allowed: false, code: 'CATEGORY_NOT_APPROVED_BY_GUARDIAN' })

    expect(
      canOfferService({
        service: tierB,
        ageInYears: 14,
        band: 'minor',
        guardianState: 'verified',
        guardianApprovedCodes: ['dog_walking'],
      }),
    ).toEqual({ allowed: true })
  })

  it('does not require per-category approval from an adult', () => {
    expect(
      canOfferService({
        service: tierB,
        ageInYears: 25,
        band: 'adult',
        guardianState: 'not_required',
        guardianApprovedCodes: [],
      }),
    ).toEqual({ allowed: true })
  })

  it('blocks a minor from a Tier C adult-only category', () => {
    expect(
      canOfferService({
        service: tierC,
        ageInYears: 17,
        band: 'minor',
        guardianState: 'verified',
        guardianApprovedCodes: ['future_adult'],
      }),
    ).toEqual({ allowed: false, code: 'ADULT_ONLY_CATEGORY' })
  })

  it('blocks Tier X even if a row is mistakenly marked active', () => {
    expect(
      canOfferService({
        service: { ...tierX, active: true },
        ageInYears: 30,
        band: 'adult',
        guardianState: 'not_required',
        guardianApprovedCodes: [],
      }),
    ).toEqual({ allowed: false, code: 'SERVICE_NOT_AVAILABLE' })
  })

  it('enforces a catalog minimum age above 13', () => {
    expect(
      canOfferService({
        service: { ...tierA, minProviderAge: 16 },
        ageInYears: 15,
        band: 'minor',
        guardianState: 'verified',
        guardianApprovedCodes: [],
      }),
    ).toEqual({ allowed: false, code: 'PROVIDER_TOO_YOUNG' })
  })

  it('blocks an unverified minor before any category question', () => {
    expect(
      canOfferService({
        service: tierA,
        ageInYears: 14,
        band: 'minor',
        guardianState: 'revoked',
        guardianApprovedCodes: [],
      }),
    ).toEqual({ allowed: false, code: 'GUARDIAN_APPROVAL_REQUIRED' })
  })
})

describe('prohibited wording is flagged, not silently accepted', () => {
  it('catches the SAFETY_TRUST_POLICY example', () => {
    const flags = flagProhibitedWording('I can also do chainsaw tree trimming on request')
    expect(flags.map((f) => f.reason)).toContain('powered cutting tools')
  })

  it('catches ladders, mowing, indoor work and off-platform payment', () => {
    expect(flagProhibitedWording('bring a ladder').map((f) => f.reason)).toContain('ladders')
    expect(flagProhibitedWording('I also mow lawns').map((f) => f.reason)).toContain('powered equipment')
    expect(flagProhibitedWording('I can tidy inside too').map((f) => f.reason)).toContain('entering a home')
    expect(flagProhibitedWording('pay me on venmo').map((f) => f.reason)).toContain('off-platform payment')
  })

  it('catches mowing however it is phrased', () => {
    for (const t of ['I also mow lawns', 'lawn mowing available', 'I have a mower', 'weed whacking']) {
      expect(flagProhibitedWording(t).map((f) => f.reason)).toContain('powered equipment')
    }
  })

  it('leaves an ordinary description alone', () => {
    expect(
      flagProhibitedWording(
        'I return your trash and recycling cans from the curb to your usual outside spot every Tuesday.',
      ),
    ).toEqual([])
  })
})

const READY_ACCOUNT: StripeAccountState = {
  accountId: 'acct_1',
  transfersActive: true,
  payoutsActive: true,
  requirementsDue: [],
}
const goodService: ServiceReadiness = {
  id: 's1',
  state: 'active',
  hasServiceArea: true,
  hasSchedule: true,
  priceCents: 300,
}

function publishInput(over: Partial<Parameters<typeof publishBlockers>[0]> = {}) {
  return {
    band: 'minor' as const,
    guardianState: 'verified' as const,
    account: READY_ACCOUNT,
    businessState: 'draft',
    publicAreaLabel: 'Oak Ridge',
    services: [goodService],
    ...over,
  }
}

describe('publish readiness', () => {
  it('allows a complete, verified, payout-ready business', () => {
    expect(canPublish(publishInput())).toEqual({ allowed: true })
  })

  it('reports every blocker at once rather than one per attempt', () => {
    const blockers = publishBlockers(
      publishInput({
        guardianState: 'invited',
        account: { ...READY_ACCOUNT, payoutsActive: false },
        publicAreaLabel: null,
        services: [],
      }),
    )
    expect(blockers).toContain('GUARDIAN_APPROVAL_REQUIRED')
    expect(blockers).toContain('PAYOUT_ONBOARDING_INCOMPLETE')
    expect(blockers).toContain('NO_ACTIVE_SERVICE')
    expect(blockers).toContain('BUSINESS_MISSING_AREA_LABEL')
  })

  it('puts the guardian blocker before the money one', () => {
    const blockers = publishBlockers(
      publishInput({ guardianState: 'invited', account: { ...READY_ACCOUNT, payoutsActive: false } }),
    )
    expect(blockers.indexOf('GUARDIAN_APPROVAL_REQUIRED')).toBeLessThan(
      blockers.indexOf('PAYOUT_ONBOARDING_INCOMPLETE'),
    )
  })

  it('does not count a draft or paused service as active', () => {
    expect(
      publishBlockers(publishInput({ services: [{ ...goodService, state: 'draft' }] })),
    ).toContain('NO_ACTIVE_SERVICE')
    expect(
      publishBlockers(publishInput({ services: [{ ...goodService, state: 'paused' }] })),
    ).toContain('NO_ACTIVE_SERVICE')
  })

  it('requires an area and a schedule on every active service', () => {
    expect(
      publishBlockers(publishInput({ services: [{ ...goodService, hasServiceArea: false }] })),
    ).toContain('SERVICE_MISSING_AREA')
    expect(
      publishBlockers(publishInput({ services: [{ ...goodService, hasSchedule: false }] })),
    ).toContain('SERVICE_MISSING_SCHEDULE')
  })

  it('refuses an under-age provider without listing anything else', () => {
    expect(publishBlockers(publishInput({ band: 'under_min_age' }))).toEqual([
      'PROVIDER_INELIGIBLE',
    ])
  })

  it('reports an already-published business as such', () => {
    expect(publishBlockers(publishInput({ businessState: 'published' }))).toEqual([
      'ALREADY_PUBLISHED',
    ])
  })

  it('blocks a revoked guardian even when everything else is complete', () => {
    expect(publishBlockers(publishInput({ guardianState: 'revoked' }))).toContain(
      'GUARDIAN_APPROVAL_REQUIRED',
    )
  })
})
