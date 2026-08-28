import { describe, expect, it } from 'vitest'
import {
  canonicalText,
  checkAcknowledgements,
  checkTypedSignature,
  CONSENT_DOCUMENTS,
  CUSTOMER_ATTESTATION,
  GUARDIAN_CONSENT,
  PUBLIC_LISTING_CONSENT,
  renderText,
  type ConsentDocument,
} from '../consent'
import { checkPriceCap, MAX_CYCLE_TOTAL_CENTS } from '../money'

const ALL = Object.values(CONSENT_DOCUMENTS)

describe('the documents themselves', () => {
  it('has the three the legal pass asked for', () => {
    expect(Object.keys(CONSENT_DOCUMENTS).sort()).toEqual([
      'customer_attestation',
      'guardian_consent',
      'public_listing_consent',
    ])
  })

  it('gives every item a stable key, unique within its document', () => {
    // The record stores keys, not text. Duplicates would make "did they
    // agree to X" unanswerable.
    for (const doc of ALL) {
      const keys = doc.items.map((i) => i.key)
      expect(new Set(keys).size, doc.kind).toBe(keys.length)
      expect(keys.every((k) => /^[a-z0-9_]+$/.test(k)), doc.kind).toBe(true)
    }
  })

  it('carries a version on every document', () => {
    for (const doc of ALL) expect(doc.version, doc.kind).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/)
  })

  it('says the things the legal pass required it to say', () => {
    const guardian = GUARDIAN_CONSENT.items.map((i) => i.key)
    // Each of these is a specific demand from DECISIONS_AND_DEMANDS.md, and
    // a wording edit that dropped one would be a silent policy change.
    for (const key of [
      'no_background_checks',
      'private_by_default',
      'messaging',
      'personally_does_the_work',
      'guardian_holds_payouts',
      'address_sharing',
      'revocable',
    ]) {
      expect(guardian, key).toContain(key)
    }

    const customer = CUSTOMER_ATTESTATION.items.map((i) => i.key)
    for (const key of ['is_adult', 'no_background_checks', 'provider_may_be_minor', 'messaging']) {
      expect(customer, key).toContain(key)
    }
  })

  it('never claims a background check anywhere', () => {
    for (const doc of ALL) {
      const all = [doc.intro, doc.statement, ...doc.items.map((i) => i.text)].join(' ')
      expect(all, doc.kind).not.toMatch(/background check(ed)?\b(?!s? — on anyone| — on anyone)/i)
      // The only mentions must be denials.
      for (const sentence of all.split(/(?<=[.!?])\s+/)) {
        if (/background check/i.test(sentence)) {
          expect(sentence, sentence).toMatch(/\bNOT\b|\bnot\b|never/)
        }
      }
    }
  })
})

describe('hashing identifies the document, not the person', () => {
  it('is stable for the same document', () => {
    expect(canonicalText(GUARDIAN_CONSENT)).toBe(canonicalText(GUARDIAN_CONSENT))
  })

  it('does not substitute the minor name before hashing', () => {
    // Two guardians signing the same version must produce the same hash.
    expect(canonicalText(GUARDIAN_CONSENT)).toContain('{{minor_name}}')
  })

  it('changes when any wording changes', () => {
    const edited: ConsentDocument = {
      ...GUARDIAN_CONSENT,
      items: GUARDIAN_CONSENT.items.map((i, n) =>
        n === 0 ? { ...i, text: `${i.text} And one more thing.` } : i,
      ),
    }
    expect(canonicalText(edited)).not.toBe(canonicalText(GUARDIAN_CONSENT))
  })

  it('changes when the items are reordered', () => {
    // A different order is a different document to somebody reading it.
    const reordered: ConsentDocument = {
      ...GUARDIAN_CONSENT,
      items: [...GUARDIAN_CONSENT.items].reverse(),
    }
    expect(canonicalText(reordered)).not.toBe(canonicalText(GUARDIAN_CONSENT))
  })

  it('changes when the version changes even if nothing else does', () => {
    const bumped: ConsentDocument = { ...GUARDIAN_CONSENT, version: '2099-01-01.1' }
    expect(canonicalText(bumped)).not.toBe(canonicalText(GUARDIAN_CONSENT))
  })

  it('distinguishes documents that share text', () => {
    expect(canonicalText(PUBLIC_LISTING_CONSENT)).not.toBe(canonicalText(GUARDIAN_CONSENT))
  })
})

describe('rendering for display', () => {
  it('substitutes the name', () => {
    expect(renderText('Let {{minor_name}} run it', { minor_name: 'Jo' })).toBe('Let Jo run it')
  })

  it('leaves an unknown placeholder alone rather than printing undefined', () => {
    expect(renderText('Hello {{nobody}}', {})).toBe('Hello {{nobody}}')
  })
})

describe('every point must be acknowledged', () => {
  it('accepts a full set', () => {
    const all = GUARDIAN_CONSENT.items.map((i) => i.key)
    expect(checkAcknowledgements(GUARDIAN_CONSENT, all)).toEqual({ ok: true })
  })

  it('refuses a partial set, and says how many are left', () => {
    // Itemized consent that accepts a partial set is a blanket consent
    // with extra steps.
    const all = GUARDIAN_CONSENT.items.map((i) => i.key)
    const r = checkAcknowledgements(GUARDIAN_CONSENT, all.slice(0, -2))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.missing).toHaveLength(2)
      expect(r.message).toContain('2')
    }
  })

  it('refuses an empty set', () => {
    expect(checkAcknowledgements(CUSTOMER_ATTESTATION, []).ok).toBe(false)
  })

  it('ignores keys that are not part of the document', () => {
    // A caller sending extra keys does not get credit for the real ones.
    const r = checkAcknowledgements(CUSTOMER_ATTESTATION, ['is_adult', 'made_up_key'])
    expect(r.ok).toBe(false)
  })
})

describe('the typed signature', () => {
  it('accepts an ordinary name', () => {
    expect(checkTypedSignature('Robin Alvarez')).toEqual({ ok: true, name: 'Robin Alvarez' })
  })

  it('normalises whitespace', () => {
    const r = checkTypedSignature('  Robin   Alvarez  ')
    if (r.ok) expect(r.name).toBe('Robin Alvarez')
  })

  it('refuses blanks and non-answers', () => {
    for (const bad of ['', '   ', 'x', '.', '123', null, undefined, 42]) {
      expect(checkTypedSignature(bad).ok, String(bad)).toBe(false)
    }
  })

  it('accepts names a stricter check would wrongly reject', () => {
    // A name check that rejects real names is worse than one that accepts
    // a fake; the fake is caught by the identity record stored with it.
    for (const name of ["O'Brien", 'Anne-Marie Q. Nguyễn', 'de la Cruz']) {
      expect(checkTypedSignature(name).ok, name).toBe(true)
    }
  })
})

describe('the price cap', () => {
  it('caps the cycle total, not the listed price', () => {
    // $20/week on a 4-week cycle bills $80 in one go. Capping the price at
    // $50 would leave that legal, and the exposure per dispute is the
    // charge, not the price.
    const r = checkPriceCap({ priceCents: 2000, priceUnit: 'week', billingCycleWeeks: 4 })
    expect(r.ok).toBe(false)
    expect(r.cycleTotalCents).toBe(8000)
  })

  it('allows the same price on a shorter cycle', () => {
    expect(checkPriceCap({ priceCents: 2000, priceUnit: 'week', billingCycleWeeks: 2 }).ok).toBe(
      true,
    )
  })

  it('allows exactly the cap', () => {
    const r = checkPriceCap({ priceCents: 1250, priceUnit: 'week', billingCycleWeeks: 4 })
    expect(r).toEqual({ ok: true, cycleTotalCents: MAX_CYCLE_TOTAL_CENTS })
  })

  it('refuses a cent over', () => {
    expect(checkPriceCap({ priceCents: 5001, priceUnit: 'visit', billingCycleWeeks: 4 }).ok).toBe(
      false,
    )
  })

  it('blocks the thousand dollar job the cap exists for', () => {
    const r = checkPriceCap({ priceCents: 100_000, priceUnit: 'visit', billingCycleWeeks: 1 })
    expect(r.ok).toBe(false)
  })

  it('tells the provider what price would fit', () => {
    const r = checkPriceCap({ priceCents: 2000, priceUnit: 'week', billingCycleWeeks: 4 })
    // $50 over 4 weeks is $12.50 a week.
    if (!r.ok) expect(r.message).toContain('$12.50')
  })

  it('counts per-visit and monthly as one occurrence', () => {
    expect(checkPriceCap({ priceCents: 5000, priceUnit: 'visit', billingCycleWeeks: 4 }).ok).toBe(
      true,
    )
    expect(checkPriceCap({ priceCents: 5000, priceUnit: 'month', billingCycleWeeks: 4 }).ok).toBe(
      true,
    )
  })
})
