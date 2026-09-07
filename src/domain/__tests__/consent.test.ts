import { describe, expect, it } from 'vitest'
import { checkPriceCap, MAX_OCCURRENCE_PRICE_CENTS } from '../pricing'
import {
  canonicalText,
  checkAcknowledgements,
  checkTypedSignature,
  CONSENT_DOCUMENTS,
  CUSTOMER_ATTESTATION,
  PROVIDER_ATTESTATION,
  renderText,
  type ConsentDocument,
} from '../consent'

const ALL = Object.values(CONSENT_DOCUMENTS)

describe('the documents themselves', () => {
  it('has one attestation for each side', () => {
    // Three, once: guardian consent, public-listing consent and the
    // customer attestation. The first two were both about minors.
    expect(Object.keys(CONSENT_DOCUMENTS).sort()).toEqual([
      'customer_attestation',
      'provider_attestation',
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

  it('says the things this product has to say', () => {
    // The guardian list was seven specific demands from
    // DECISIONS_AND_DEMANDS.md, every one of them about a minor: private by
    // default, the guardian holding payouts, revocability. None survive.
    //
    // What both sides must still be told does survive, and a wording edit
    // that dropped one of these would be a silent policy change: nobody is
    // checked, and the platform is not in the middle of the money.
    const provider = PROVIDER_ATTESTATION.items.map((i) => i.key)
    for (const key of ['is_adult', 'no_background_checks', 'own_arrangement']) {
      expect(provider, key).toContain(key)
    }

    const customer = CUSTOMER_ATTESTATION.items.map((i) => i.key)
    for (const key of [
      'is_adult',
      'no_background_checks',
      'pay_the_provider_directly',
      'messaging',
    ]) {
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
    expect(canonicalText(PROVIDER_ATTESTATION)).toBe(canonicalText(PROVIDER_ATTESTATION))
  })

  it('is the same text for everybody who signs that version', () => {
    // Two people signing the same version must produce the same hash, or
    // the hash identifies the signer rather than the document. Nothing is
    // templated into these any more -- {{minor_name}} was the only
    // substitution and it went with the minors -- so this is now a check
    // that none crept back in.
    for (const doc of ALL) {
      expect(canonicalText(doc), doc.kind).not.toMatch(/\{\{/)
    }
  })

  it('changes when any wording changes', () => {
    const edited: ConsentDocument = {
      ...PROVIDER_ATTESTATION,
      items: PROVIDER_ATTESTATION.items.map((i, n) =>
        n === 0 ? { ...i, text: `${i.text} And one more thing.` } : i,
      ),
    }
    expect(canonicalText(edited)).not.toBe(canonicalText(PROVIDER_ATTESTATION))
  })

  it('changes when the items are reordered', () => {
    // A different order is a different document to somebody reading it.
    const reordered: ConsentDocument = {
      ...PROVIDER_ATTESTATION,
      items: [...PROVIDER_ATTESTATION.items].reverse(),
    }
    expect(canonicalText(reordered)).not.toBe(canonicalText(PROVIDER_ATTESTATION))
  })

  it('changes when the version changes even if nothing else does', () => {
    const bumped: ConsentDocument = { ...PROVIDER_ATTESTATION, version: '2099-01-01.1' }
    expect(canonicalText(bumped)).not.toBe(canonicalText(PROVIDER_ATTESTATION))
  })

  it('distinguishes documents that share text', () => {
    expect(canonicalText(CUSTOMER_ATTESTATION)).not.toBe(canonicalText(PROVIDER_ATTESTATION))
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
    const all = PROVIDER_ATTESTATION.items.map((i) => i.key)
    expect(checkAcknowledgements(PROVIDER_ATTESTATION, all)).toEqual({ ok: true })
  })

  it('refuses a partial set, and says how many are left', () => {
    // Itemized consent that accepts a partial set is a blanket consent
    // with extra steps.
    const all = PROVIDER_ATTESTATION.items.map((i) => i.key)
    const r = checkAcknowledgements(PROVIDER_ATTESTATION, all.slice(0, -2))
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
  it('caps one visit, not the cycle total', () => {
    // Corrected by the product owner on 2026-08-30: "a $35 weekly
    // lawn-mowing service should be valid. Four completed weekly visits
    // may legitimately total $140 in one billing cycle."
    const r = checkPriceCap({ priceCents: 3500, priceUnit: 'week' })
    expect(r.ok).toBe(true)
  })


  it('allows exactly the cap', () => {
    const r = checkPriceCap({ priceCents: MAX_OCCURRENCE_PRICE_CENTS, priceUnit: 'visit' })
    expect(r.ok).toBe(true)
  })

  it('refuses a cent over', () => {
    expect(
      checkPriceCap({ priceCents: MAX_OCCURRENCE_PRICE_CENTS + 1, priceUnit: 'visit' }).ok,
    ).toBe(false)
  })

  it('refuses a single visit over the cap however short the cycle', () => {
    expect(checkPriceCap({ priceCents: 5001, priceUnit: 'week' }).ok).toBe(
      false,
    )
  })

  it('blocks the thousand dollar job the cap exists for', () => {
    const r = checkPriceCap({ priceCents: 100_000, priceUnit: 'visit' })
    expect(r.ok).toBe(false)
  })

  it('names the cap in terms of a single visit', () => {
    const r = checkPriceCap({ priceCents: 9000, priceUnit: 'week' })
    if (!r.ok) {
      expect(r.message).toContain('$50')
      expect(r.message).toContain('single visit')
    }
  })

  it('counts per-visit and monthly as one occurrence', () => {
    expect(checkPriceCap({ priceCents: 5000, priceUnit: 'visit' }).ok).toBe(
      true,
    )
    expect(checkPriceCap({ priceCents: 5000, priceUnit: 'month' }).ok).toBe(
      true,
    )
  })
})
