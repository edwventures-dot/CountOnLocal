# What the product actually does

**For:** counsel drafting Terms / Privacy / Safety Center, and marketing
keeping the copy honest.
**From:** the developer, 2026-08-28. **Status:** describes code that is
built and tested, not intentions.

The handoff rule stands: the documents and the code must agree. This file
exists so counsel describes behaviour that exists, and so marketing can
see which sentences in the current drafts are not yet true.

Everything below has been exercised against the real database and, where
money is involved, against real Stripe test mode.

---

## 1. Things the drafts assumed that were not true

Two of the four are now built and the consent wording has been corrected
to match. Two remain, and they are the only items in this file that are
actively wrong today.

### 1.1 Completion photos — BUILT 2026-08-28

Was: promised in the signed consent, did not exist. Now built, minimum
version: one photo per completed visit, optional.

- EXIF and all other metadata stripped **before storage**, not before
  display — otherwise the original sits in a bucket and every backup with
  the coordinates in it. Verified by uploading a JPEG with GPS
  coordinates and confirming they are absent from the stored bytes.
- Private bucket, **no signed URLs**. Every fetch is authorized: the
  provider, the customer, a cleared guardian, and staff handling an
  incident. Anyone else gets 404, because "you may not see this" confirms
  something is there.
- Staff viewing somebody's photo writes an audit row. The parties to the
  job do not.
- Optional on purpose. A required photo means a provider with a flat
  battery cannot mark work they actually did, which ends with a customer
  not charged and a teenager not paid.

Consent wording updated to match, and the document version moved with it.

### 1.2 Dog information — BUILT 2026-08-28

Was: asked for in a signed attestation, with no field behind it. Now
collected at checkout for dog services and shown to the provider **above
the address, as a warning**, not folded into the instructions text.

Bite history has three values and `unsure` is one of them. A rescue dog's
history is often genuinely unknown, and forcing that into "no" turns an
honest gap into a false reassurance. The provider is told the history is
not known, and told they may refuse the stop.

Consent wording updated to match, and the version moved with it.

### 1.3 "Signer identity (verified)" overstates what we know

The handoff asks the consent record to store "signer identity
(verified)". At the moment somebody signs, we know two things: they hold
a confirmed email address, and they are signed in. That is all.

The record says exactly that — `verification_method:
authenticated_session` — and it must not say more. Stripe's identity
check happens later, at payout onboarding, and is a different fact about
a different moment.

**Counsel should not describe guardian identity as verified at consent
time.** The honest phrasing is that the consent is attributable to an
authenticated account holder.

### 1.4 Payouts do not happen yet

The ledger records what each provider is owed, to the cent, and balances.
**Nothing transfers it.** There is no payout execution, so "payouts are
immediate" is not currently true or false — it is unimplemented.

Anything the documents say about payout timing is describing future
behaviour. Say so, or omit it.

---

## 2. What is enforced, precisely

### Age and guardianship

- Minimum provider age **13**, enforced in three places: the signup
  check, a database constraint, and the age gate at onboarding. Verified
  live at the boundary — somebody who turns 13 today is accepted, and a
  date one day later is refused.
- A provider aged **13–17 cannot take a paying customer** until the
  guardian relationship reaches `verified`.
- Guardian state is a state machine with eight states, not a boolean.
  Revocation is a real transition with an immediate effect, not a flag.
- **A provider cannot be their own guardian.** Enforced in the service
  and by a database constraint. This was reachable at one point and is
  now closed.
- Customers attest to being 18+. **That is an attestation, not a check.**
  We do not verify anybody's age.

### Turning eighteen

- Handled automatically. On the eighteenth birthday the guardian
  requirement is cleared and the relationship ends.
- **The payout account is detached**, because a minor's payouts go to a
  Connect account in the guardian's name and a Connect account cannot be
  moved between legal persons. Earnings keep accruing in the ledger and
  nothing is lost; they stop paying out until the new adult connects their
  own account.
- Both the provider and the guardian are warned **thirty days ahead** and
  again on the day. The guardian is told because their deposits stop, and
  finding that out from a missing payment is a bad way to learn it.
- Counsel should note this: the guardian consent says "I hold the money
  until they turn 18", and that sentence is now literally true.

### Guardian consent (ESIGN / UETA)

- **Itemized.** Eleven points, each acknowledged separately. A partial
  set is refused; the record stores which keys were checked, so "did they
  agree to the messaging disclosure" is answerable on its own.
- **Typed full legal name** as the electronic signature. This is a valid
  signature under ESIGN/UETA — what matters is intent, attribution and
  record integrity. There is no hand-drawn signature and no wet ink, by
  decision.
- **Stored:** signer, subject minor, the exact document text, its SHA-256
  hash, the version, the timestamp, a hashed IP, the user agent, and the
  verification method.
- **Append-only in the real sense.** A database trigger refuses UPDATE
  and DELETE from *every* role, including the one the application runs
  as. Proven by trying it. Revocation is a new row pointing at the
  original; the original is never touched.
  - Honest limit: somebody with database ownership could drop the
    trigger. That is an access-control and backup problem, not something
    a schema can prevent, and it should not be described as tamper-proof.
- **Signing the consent is what verifies the relationship.** The record
  is the permission; there is no separate switch an operator can flip.

### Default-private listings

- A minor's storefront is **reachable by direct link and QR code always**
  — that is the primary intended flow and is unchanged.
- It is **not findable**: served with `noindex, nofollow, nosnippet,
  nocache` until a guardian signs the separate Public Listing Consent.
- Withdrawing that consent returns it to private immediately. The link
  keeps working.
- **There is no search or discovery feature at all.** So "will not appear
  in search results" is true today only because no search exists. Prefer
  wording like "will not be listed or indexed".
- Even when public, the page shows business information only. No home
  address, school, date of birth, last name, or exact schedule. Verified:
  the service-area centre point and geometry appear nowhere in the
  response.

### Money

- The provider keeps **100%** of their listed price. There is no provider
  fee. The ledger balances to zero on every movement, which is what makes
  that checkable rather than asserted.
- The customer pays a platform fee on top: **15% with a $1.00 minimum per
  cycle**, held as configuration.
- **Maximum $50 per service per billing cycle.** Note this caps the cycle
  total, not the listed price — a $20/week service on a 4-week cycle
  would bill $80 and is refused. The practical effect is that a weekly
  service on a 4-week cycle is limited to **$12.50/week**. If that is too
  low for yard work, the cap or the cycle length has to change.
- Cards are handled entirely by Stripe. **We never see or store a card
  number** — Stripe.js runs in an iframe on Stripe's domain.
- Refunds are issued in-app and cannot exceed what was actually charged;
  the ceiling is computed from the ledger, not taken from the request.
- **No monetary penalties on users, ever.** There is no code path that
  can fine anybody, and there should not be one — the provider is
  frequently a minor whose payout account we hold.

### Consequences

- Strike, suspend, ban, reinstate. Append-only history; standing is
  derived from it rather than stored as a flag.
- **Strikes never suspend automatically.** Three raises a recommendation
  to a human who decides and writes down why.
- A ban cannot be undone in the console; it must be escalated.
- Nobody can action their own account.
- A suspended account **cannot take any action** — enforced centrally, on
  every mutating request — but can still read its own pages, and can
  still file a safety report. Someone suspended last week who witnesses
  something dangerous today must still be able to say so.

### Privacy

- A provider's home address, school, exact age and date of birth are
  never public and never sent to analytics.
- Analytics uses an **allowlist**: a field is dropped unless explicitly
  named. Postal codes are truncated to three digits.
- Access and gate codes are restricted: never in an email, a notification
  preview, a log, or an analytics payload. They appear on the provider's
  route screen and nowhere else.
- Email carries a sentence and a link, never the thing itself — an inbox
  is not an authenticated channel.
- Every sensitive staff action is audit-logged with the actor, the role
  that authorised it, and a written reason of at least 20 characters.
- Reading a customer's address as staff is individually audited, and the
  audit row is written *before* the address is returned.

### What we never claim

The product refuses to say these, and the documents must not reintroduce
them:

- **No background checks are performed, on anyone.** "Identity verified"
  refers only to Stripe's payment identity check.
- No guarantee of safety. No "fully vetted". No "safe provider".
- Trust badges are factual: "Guardian connected" appears only where a
  guardian is genuinely verified. An adult provider with no guardian
  shows "Identity verified" instead, or nothing.

---

## 3. Still unanswered, and I cannot invent them

These need the owner or counsel. They are not written down anywhere and I
have deliberately not guessed:

- **Retention periods.** How long do we keep messages, photos (when they
  exist), addresses, audit rows, consent records?
- **Deletion rights.** What can somebody ask to have deleted, and what
  must be kept regardless — the consent records are append-only by
  design, which interacts with this directly.
- **A minor's data on account closure.** Including what happens to their
  consent record and their earnings history.

---

## 4. One thing worth knowing about how this was built

Five times now, a capability has been declared in the design and never
wired up, with nothing failing in the meantime because absence is silent:
a service state that nothing could reach, a role nothing granted, a
guardian verification event nothing fired, an audit field recording the
wrong role, and an account status column nothing read — which meant a
suspended account could do everything an active one could.

All five are fixed. The reason to mention it here is that **a capability
appearing in a design document is not evidence it works.** If counsel or
marketing needs to rely on a specific behaviour, ask and I will exercise
it against the real system rather than reading the code and assuming.
