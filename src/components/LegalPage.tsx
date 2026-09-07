import Link from 'next/link'
import type { LegalDocument } from '@/content/legal'
import { COMPANY, LEGAL_DOCUMENTS } from '@/content/legal'

/**
 * One rendering for all three legal documents.
 *
 * ## The draft banner is not decoration
 *
 * A legal page that looks finished IS finished, as far as a reader is
 * concerned. So a draft says so at the top, before the first section, in
 * the same visual weight as an error — not in small grey text at the
 * bottom where it reads as a formality.
 *
 * ## Open questions are shown, not hidden
 *
 * Sections counsel still has to write are rendered with what has to be
 * decided, rather than omitted. Omitting them would make the draft look
 * more complete than it is, which is the failure this whole file exists to
 * avoid: the reader cannot tell a finished document from one missing its
 * limitation of liability.
 *
 * When counsel delivers, `needsCounsel` goes away and the note disappears
 * with it. Nothing here needs changing.
 *
 * ## Why the banner has two versions
 *
 * The original said "no one can sign up yet". That was true while the
 * pre-launch gate 404'd every route, and it becomes FALSE the moment the
 * first invited neighbour creates an account -- a false sentence sitting
 * under a banner promising the page describes what the product actually
 * does, on the one page where being wrong is most expensive.
 *
 * So during an invited pilot it says what is true instead: people are
 * using this, the document is still a draft, and a draft is a statement of
 * intent rather than an agreement they have entered into. `pilot` is
 * passed in rather than read here so the three route files stay the only
 * things that touch the environment.
 */
export function LegalPage({ doc, pilot = false }: { doc: LegalDocument; pilot?: boolean }) {
  const isDraft = doc.status === 'draft'

  return (
    <div className="legal">
      <header className="legal__head">
        <Link className="legal__brand" href="/">
          Count On Local
        </Link>
        <h1 className="legal__title">{doc.title}</h1>
        <p className="legal__summary">{doc.summary}</p>
        <p className="legal__meta">
          {isDraft ? (
            <>Version {doc.version}</>
          ) : (
            <>
              Version {doc.version} · In force from {doc.effectiveDate}
            </>
          )}
        </p>
      </header>

      {isDraft ? (
        <div className="legal__banner" role="note">
          <strong>This is a draft and is not in force.</strong>
          {pilot ? (
            <p>
              Count On Local has not launched publicly. A small number of invited people are using
              it in one neighbourhood while the wording on this page is still being reviewed
              against what the product actually does. Sections still being written are marked
              below — until they are finished and this document is in force, it is a description
              of how we intend to behave rather than an agreement you have entered into.
            </p>
          ) : (
            <p>
              Count On Local has not launched and no one can sign up yet. This page is published so
              the wording can be reviewed against what the product actually does. Nothing on it
              creates an agreement, and sections still being written are marked below.
            </p>
          )}
        </div>
      ) : null}

      {doc.sections.map((section) => (
        <section className="legal__section" key={section.id} id={section.id}>
          <h2>{section.heading}</h2>
          {section.body.map((paragraph, i) => (
            <p key={i}>{paragraph}</p>
          ))}
          {section.needsCounsel ? (
            <div className="legal__pending">
              <strong>Still being written.</strong>
              <p>{section.needsCounsel}</p>
            </div>
          ) : null}
        </section>
      ))}

      <LegalFooter />
    </div>
  )
}

/**
 * The footer every page gets.
 *
 * Exported separately because the landing page needs it too, and two
 * footers listing different documents is how one of them ends up missing a
 * link after somebody adds a fourth.
 */
export function LegalFooter() {
  return (
    <footer className="legal__footer">
      <nav aria-label="Legal">
        {LEGAL_DOCUMENTS.map((d) => (
          <Link key={d.slug} href={`/${d.slug}`}>
            {d.title}
          </Link>
        ))}
      </nav>
      <p>Count On Local is a product of {COMPANY}.</p>
    </footer>
  )
}
