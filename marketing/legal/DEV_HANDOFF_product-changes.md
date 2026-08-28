# Dev handoff — Count On Local product changes from the legal/safety pass

**Date:** 2026-08-28 · From: marketing + owner (Trey) · For: the developer.
The handoff rule stands: **the documents and the code must agree** — where they differ,
change the code (or tell marketing and we change the copy). Sources:
`marketing/legal/DECISIONS_AND_DEMANDS.md`, `consent-and-attestations.md`, `safety-center.md`.

## 1. Minor listings are PRIVATE by default; public search is a separate opt-in
- A minor provider's storefront must **not** appear in Discovery/search by default.
- **Direct share link + QR flyer always work** (unchanged) — that's the intended primary flow.
- Add a separate **Public Listing Consent** (guardian) that toggles search/discovery
  visibility on. Revocable → immediately removes the listing from search.
- Consistent with PRD §22 (discovery is secondary) and Safety §18 (indexable only after
  opt-in). This makes **private the enforced default** and adds the second signed consent.

## 2. Itemized informed consent (clickwrap), stored immutably
- Guardian consent must present the key points as **individual acknowledgments (a checkbox
  per item)** before the signature — not one blanket "I agree." Exact copy in
  `consent-and-attestations.md`.
- **Three signed artifacts total:** (a) base Guardian Consent, (b) Public Listing Consent,
  (c) Customer Attestation at checkout.
- **Store, per signature** (ESIGN/UETA record): signer identity (verified), which minor it's
  for, the **exact consent text version + hash**, **timestamp**, verification method, and the
  revocation state. **Immutable audit record** — extend the existing guardian `verified` state
  + audit log to capture the artifact itself, not just a boolean. Optionally render a PDF the
  guardian keeps.

## 3. Price cap: $50 max per service, per cycle
- Config value. Block creating or pricing a service above **$50/cycle**.
- Purpose: keeps every dispute trivial and blocks abuse (no $1,000 "jobs" to move money).

## 4. Payouts immediate; disputes resolved in-app
- **Payout to the guardian is immediate** (owner's decision).
- Dispute/refund flow: support/owner reviews and issues a **fast in-app refund** — the goal is
  to resolve it before it becomes a **card chargeback** (~$15 fee + hurts Stripe standing).
- **Consequences are account-based, not monetary** — strike / suspend / ban. Do **not** try to
  charge users penalty fees. (The proportional credit/refund-on-cancel logic in PRD §12/§16 stays.)

## 5. "The approved provider must personally do the work"
- Surface as an explicit rule with a **ban** consequence. Backed by completion photos + reports;
  it is not technically auto-verifiable, so it's a policy rule, not a system guarantee.

## 6. Declare every capability in the docs + consent (esp. messaging)
- The Terms/Privacy/consent must **disclose the full feature set** — in particular the **in-app
  messaging system** (PRD §17), plus address sharing after checkout, completion photos, public
  reviews, notifications, and guardian visibility of addresses tied to jobs. The itemized consent
  already names these; keep the formal docs in sync.

## Still open (not blocking these builds)
- **Counsel questions** (for whenever the flat-fee legal review happens): data **retention
  periods**, **deletion rights**, and how a **minor's data is handled on account closure** — the
  handoff says these aren't written down yet. Do not invent them; they need the owner/lawyer.
