# Count On Local — Owner demands & product/safety decisions

**Date:** 2026-08-28 · Owner: Trey (EDW Ventures) · Captured by marketing.
Source of truth for: the Terms/Privacy/Safety **copy**, a **dev note** (product changes),
and the **counsel-questions** list. Owner decisions + marketing refinements.

---

## 1. Neighbors you already know — not the general public
The product is for people who **already know each other**. The neighbors vet each other
— on both sides. **Count On Local vets no one and runs no background checks.** Both the
**guardian and the customer acknowledge this at signup** (an attestation, not fine print).
This is a positioning + liability decision, not just a line of copy.

## 2. Minor listings are PRIVATE by default; public search is a separate opt-in
- A minor's listing does **not** appear in public search/discovery by default.
- Their **QR code / flyer / direct link always works** — people who already know them can
  reach and subscribe with no search. This is the intended (hero) flow.
- To appear in **public search**, the guardian signs a **separate "Public Listing
  Consent."** Revocable at any time.
- Even when public, the listing shows only **scrubbed business data** — no DOB, no last
  name, no home address, no school; coarse area only (existing minor-privacy defaults).
- Aligns with existing safety policy §18 ("indexable after provider/guardian opt-in") —
  this makes **private the default** and adds the second signed consent.

## 3. The approved provider must personally do the work
No substitutes — a cousin can't cover a day. **Violation → ban.** Enforced by rule +
completion photos + reports (not technically automatic; can't verify who showed up).

## 4. Guardian consent = stored clickwrap e-signature (ESIGN / UETA — no wet ink needed)
Store, for **each** consent: the verified guardian, which minor, the **exact consent
text version (hash)**, the **timestamp**, the verification method, and that it's
revocable — as an **immutable audit record.** Optionally generate a PDF the guardian
keeps. There are now **two consent types**: (a) base guardian consent, (b) Public Listing
Consent (#2). A lawyer blesses the wording later.

## 5. Payments & disputes
- **Per-service price cap** (config; modest; **owner sets the number** — OPEN). Keeps
  disputes trivial and blocks abuse (no $1,000 "jobs").
- **Fast in-app refunds** to prevent card **chargebacks** (~$15 each + hurts Stripe
  standing). Owner reviews and covers small amounts.
- **No monetary penalties on users** — use **account consequences** (strike / suspend /
  ban) instead. Refund the wronged neighbor; remove the jerk.
- **Payout timing — OPEN:** immediate vs. a short hold window (hold = refunds come from
  held funds, dampens fraud). Runs on **Stripe Connect**.
- Exposure per dispute ≈ one billing cycle × capped price = trivial.

---

## Status
- **Resolved:** #1 (default-private + QR + public opt-in model), #2, #3, #4 approach.
- **Owner still to decide:** price-cap number; payout timing (immediate vs short hold).
- **Next:** fold into Safety Center + draft the guardian/customer attestation + the
  Public Listing Consent copy; write the dev note (product changes); build the
  counsel-questions list.
