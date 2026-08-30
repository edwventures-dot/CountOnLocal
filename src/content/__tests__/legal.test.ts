import { describe, expect, it } from 'vitest'
import { anyDraft, LEGAL_DOCUMENTS, legalDocument } from '../legal'
import { MAX_OCCURRENCE_PRICE_CENTS } from '@/domain/money'
import { RETENTION } from '@/domain/retention'

/**
 * Only what the document itself says.
 *
 * `needsCounsel` notes are excluded deliberately: they are instructions TO
 * counsel and legitimately contain the forbidden phrases as prohibitions
 * ("do not describe the platform as Texas-only"). Including them made the
 * scanner flag its own warnings, which is a scanner measuring itself.
 */
const allText = LEGAL_DOCUMENTS.flatMap((d) =>
  d.sections.flatMap((s) => [s.heading, ...s.body]),
).join('\n')

/**
 * Sentences, so a denial can be told from a claim.
 *
 * The first version scanned whole documents for phrases like "background
 * check" and flagged the Safety Center for saying "We do not run background
 * checks" — which is the sentence we most want on the page.
 *
 * The real rule is narrower: these phrases may appear ONLY in a denial. So
 * the scan works sentence by sentence and skips anything that negates.
 */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
}

const NEGATED = /\b(do not|does not|don’t|doesn’t|never|no|nor|without|cannot|is not|are not)\b/i

/** Sentences that assert something, with denials removed. */
function claimingSentences(): string[] {
  return sentences(allText).filter((line) => !NEGATED.test(line))
}

describe('claims the product cannot back', () => {
  /**
   * From marketing/legal/WHAT_THE_PRODUCT_ACTUALLY_DOES.md, "What we never
   * claim". These would be false the moment they were written, and a legal
   * page is the worst place for a false sentence.
   *
   * This exists because the copy will be edited by people who have not read
   * that document. A phrase like "fully vetted" is cheap to add and
   * expensive to discover.
   */
  const forbidden: Array<[RegExp, string]> = [
    [/\bbackground[- ]check/i, 'No background checks are performed on anyone.'],
    [/\bfully vetted\b/i, 'Nobody is vetted.'],
    [/\bvetted\b/i, 'Nobody is vetted.'],
    [/\bscreened\b/i, 'Nobody is screened.'],
    [/\bsafe provider/i, 'We do not guarantee anybody’s safety.'],
    [/\bguarantee[ds]?\b[^.]{0,30}\bsaf(e|ety)/i, 'We do not guarantee safety.'],
    [/\binstant(ly)?\b[^.]{0,30}\bpay/i, 'Payouts are scheduled, not instant.'],
    [/\bpay(out|ment)s?\b[^.]{0,30}\binstant/i, 'Payouts are scheduled, not instant.'],
    [/\bphotos?\b[^.]{0,30}\brequired\b/i, 'Completion photos are optional.'],
    [/\brequired\b[^.]{0,30}\bphotos?\b/i, 'Completion photos are optional.'],
    [/Texas[- ]only/i, 'Owner’s response 2026-08-30: the platform is not Texas-only.'],
  ]

  for (const [pattern, why] of forbidden) {
    it(`makes no claim matching ${pattern}`, () => {
      const offending = claimingSentences().filter((line) => pattern.test(line))
      expect(offending.length === 0 ? null : `${offending[0]} — ${why}`).toBeNull()
    })
  }

  it('catches a bad sentence when there is one', () => {
    // A positive control. A scanner that never fires looks exactly like a
    // clean document, and without this the whole file would be decoration.
    // It has already earned its place once: an escaping mistake left every
    // pattern requiring a literal backspace character, so nothing matched
    // anything and every other test in this block passed.
    const bad = 'Every provider on Count On Local is fully vetted and background checked.'
    expect(NEGATED.test(bad)).toBe(false)
    expect(forbidden.filter(([pattern]) => pattern.test(bad)).length).toBeGreaterThan(0)
  })

  it('still allows the denials, which are the sentences we want most', () => {
    // "We do not run background checks" must survive. If this ever fails,
    // the scanner has started removing the honesty it exists to protect.
    const safety = legalDocument('safety')!
    const denials = safety.sections.find((s) => s.id === 'what-we-do-not-do')!.body.join(' ')
    expect(denials).toMatch(/do not run background checks/i)
    expect(denials).toMatch(/do not guarantee/i)
  })

  it('does not describe guardian identity as verified at consent time', () => {
    // At signature time we know two things: a confirmed email, and that
    // they are signed in. Stripe's identity check is later and different.
    for (const doc of LEGAL_DOCUMENTS) {
      for (const section of doc.sections) {
        for (const paragraph of section.body) {
          expect(
            /guardian(’s|'s)? identity (is |has been )?verif/i.test(paragraph),
            `${doc.slug}/${section.id}`,
          ).toBe(false)
        }
      }
    }
  })
})

describe('facts that must match the code', () => {
  it('states the price cap as a per-visit figure with the real number', () => {
    const terms = legalDocument('terms')!
    const fees = terms.sections.find((s) => s.id === 'prices-and-fees')!.body.join(' ')
    const dollars = `$${(MAX_OCCURRENCE_PRICE_CENTS / 100).toFixed(2)}`

    expect(fees).toContain(dollars)
    // The cap is per visit and the page has to say so — the previous rule
    // capped the cycle total and the two read almost identically.
    expect(fees).toMatch(/single visit/i)
  })

  it('does not claim a cycle total is capped', () => {
    // It is not, since 2026-08-30. A $35 weekly service bills $140.
    expect(allText).not.toMatch(/\$50[^.]{0,40}(per|a|each) (cycle|month)/i)
  })

  it('states retention periods that match the policy', () => {
    const privacy = legalDocument('privacy')!
    const retention = privacy.sections.find((s) => s.id === 'retention')!.body.join(' ')

    // If the policy changes and this page does not, the page becomes a
    // promise the job does not keep.
    expect(RETENTION.message_ordinary.days).toBe(365)
    expect(retention).toMatch(/one year/i)

    expect(RETENTION.message_flagged.days).toBe(365 * 3)
    expect(retention).toMatch(/three years/i)

    expect(RETENTION.completion_photo.days).toBe(180)
    expect(retention).toMatch(/six months/i)

    expect(RETENTION.notification.days).toBe(90)
    expect(retention).toMatch(/ninety days/i)

    expect(RETENTION.ledger_entry.days).toBe(365 * 7)
    expect(retention).toMatch(/seven years/i)
  })

  it('says deletion does not erase everything', () => {
    // The one thing the owner's response is explicit about for this page:
    // "do not promise that every record is immediately deleted."
    const deletion = legalDocument('privacy')!.sections.find((s) => s.id === 'deletion')!
    const text = deletion.body.join(' ')
    expect(text).toMatch(/we do not claim to erase everything/i)
    expect(text).toMatch(/what stays/i)
  })

  it('describes a minor listing as reachable but not indexed', () => {
    const listings = legalDocument('safety')!.sections.find((s) => s.id === 'listings')!
    const text = listings.body.join(' ')
    expect(text).toMatch(/direct link|QR/i)
    expect(text).toMatch(/not (listed|indexed)/i)
  })
})

describe('the draft is honest about being a draft', () => {
  it('has no effective date while it is a draft', () => {
    // A date reads as "in force" no matter what the banner says.
    for (const doc of LEGAL_DOCUMENTS) {
      if (doc.status === 'draft') expect(doc.effectiveDate, doc.slug).toBeNull()
    }
  })

  it('requires an effective date once in force', () => {
    for (const doc of LEGAL_DOCUMENTS) {
      if (doc.status === 'in_force') expect(doc.effectiveDate, doc.slug).toBeTruthy()
    }
  })

  it('says what has to be decided wherever a section is unfinished', () => {
    // A bare empty section looks like an oversight. A section with a note
    // saying what is missing is a handoff.
    for (const doc of LEGAL_DOCUMENTS) {
      for (const section of doc.sections) {
        if (section.body.length === 0) {
          expect(section.needsCounsel, `${doc.slug}/${section.id}`).toBeTruthy()
        }
      }
    }
  })

  it('still has open questions, which is why nothing is in force yet', () => {
    const pending = LEGAL_DOCUMENTS.flatMap((d) => d.sections).filter((s) => s.needsCounsel)
    expect(pending.length).toBeGreaterThan(0)
    expect(anyDraft()).toBe(true)
  })

  it('has not left a section without a heading or a unique id', () => {
    for (const doc of LEGAL_DOCUMENTS) {
      const ids = doc.sections.map((s) => s.id)
      // Duplicate ids break the in-page anchors silently.
      expect(new Set(ids).size, doc.slug).toBe(ids.length)
      for (const s of doc.sections) {
        expect(s.heading.length, `${doc.slug}/${s.id}`).toBeGreaterThan(3)
      }
    }
  })
})
