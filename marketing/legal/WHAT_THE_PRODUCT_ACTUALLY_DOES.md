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

Three of the four are now built and the consent wording has been
corrected to match. One remains, and it is the only item in this file
that is actively wrong today.

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

### 1.4 Payouts — BUILT 2026-08-28

Was: the ledger recorded what was owed and nothing moved it. Now built.

- Paid as a Stripe Connect transfer to the account that holds the money —
  the **guardian's** account for a provider aged 13-17, which is what the
  guardian consented to.
- "Immediate" means **within one job run** of being credited: it runs in
  the same daily pass as settlement, directly after it. Not literally
  instant, and the documents should not say instant.
- Nothing is paid while a payout hold is open, while the guardian is not
  cleared, or before Stripe onboarding is finished. In each case the money
  stays owed rather than being forfeited.
- An unsettled platform balance is treated as waiting rather than
  failing — card payments take days to settle and the next run retries.
- Stripe pays the connected account out to its bank on **its own
  schedule**. That second leg is Stripe's, not ours, and the documents
  should not describe it as something we control.

One thing counsel should know: the successful transfer leg has not been
exercised against real Stripe, because completing Express onboarding
needs a browser. What WAS exercised live: an account without the
transfers capability is refused and no ledger row is written. The success
path is covered by integration tests against a stubbed processor.

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

## 3. Retention and deletion — BUILT 2026-08-28, numbers need sign-off

These were the three items I said I could not invent. The **mechanism** is
now built and tested; the **periods** are proposals that need counsel's
agreement or correction. Both parts are in one file,
`src/domain/retention.ts`, with a written reason against every number so
they can be overruled individually rather than as a block.

Changing a period is a one-line edit in that file. Nothing else in the
codebase decides how long anything is kept.

### 3.1 The proposed periods

| What | Kept for | Clock starts | Then |
|---|---|---|---|
| Ordinary messages | 1 year | message sent | body replaced |
| Reported/blocked messages | 3 years | message sent | body replaced |
| Completion photos | 180 days | the visit | file and row deleted |
| Customer addresses | 180 days | last subscription there ending | emptied |
| Notification records | 90 days | queued | deleted |
| Ledger entries | 7 years | entry written | — see 3.3 |
| Audit log | 7 years | the action | — see 3.3 |
| Consent records | 7 years | **relationship ending**, not signing | signature redacted |
| Incidents | 7 years | resolution | — see 3.3 |
| Strikes / suspensions / bans | 7 years | the action | — see 3.3 |

Three of these have reasoning counsel may want to push on:

- **180 days for photos and addresses** is set by the **card chargeback
  window** (~120 days). Evidence for a disputed visit has to outlive the
  window in which the dispute can arrive, or we defend a chargeback with
  nothing in hand. Shorter than ~130 days breaks that.
- **7 years** is the ordinary US business-records expectation. It is the
  single number in this file most likely to be wrong, particularly for
  money held on behalf of minors.
- **The consent clock starts when the guardian relationship ends**, not
  when the document was signed. A consent signed when a provider was 13
  and revoked at 17 is retained from 17. This is deliberate and doubles
  the effective retention in the common case.

Nothing is retained indefinitely. That is asserted by a test, not assumed.

### 3.2 What "delete my account" actually does

**It does not delete the account row, and it never could have.** Three
tables reference `users` with `on delete restrict` — consent records,
completion photos, incident reports. A hard delete of anybody who has
signed a consent, uploaded a photo or been named in a report fails on a
foreign key. That predates this work; it is the correct behaviour, so it
is now written down and built on.

Closing an account instead:

- replaces the email with a unique address at `.invalid`, a TLD reserved
  so it can never be registered or delivered to, and clears the phone.
  (Both columns are unique and one is required, so neither can be blanked.)
- replaces the provider display name.
- empties every address on the account, **including the geocoded
  coordinates** — which are a more precise address than the text, and are
  the field an ordinary update silently misses.
- deletes notification records and completion photos.
- redacts messages the person sent — **except reported or blocked ones**.
  Otherwise the way to erase a report about your conduct is to close your
  account.

**Two refusals**, both protecting the person asking:

- **Money still owed** — closure is refused until it has been paid out.
  It is their own money, and for a 13–17 provider it is a minor's money
  sitting in a guardian's account.
- **A live subscription** — cancel first, so nobody is charged for work
  nobody is scheduled to do.

Counsel should know these exist, in case a deletion right somewhere
requires closure regardless. The answer would be to pay out and cancel
first, not to remove the checks.

`GET /api/v1/account/close` returns exactly what closure will do, read
from the same table the job acts on — so the confirmation screen and the
code cannot drift apart. **The product must never tell somebody their data
is gone while retaining seven years of it**, and this is the mechanism
that prevents it.

### 3.3 De-identification, honestly

For the ledger, the audit log, incidents and account actions there is **no
separate erasure sweep, and there could not be** — nothing in those rows
names anybody. They carry a user id and a fact. They stop being personal
data the moment the account row those ids point at stops naming a person,
which happens at closure.

This is worth stating precisely because it is easy to write a policy
promising a sweep that no code performs. Every class is marked in the
policy as either genuinely swept or covered by the account row, and a test
fails if a class is listed as swept and nothing touches it.

### 3.4 A minor's data on closure

Same as anyone's, with two specifics:

- **Earnings history stays**, de-identified. It is a financial record and
  the money genuinely moved. Closure is refused while any of it is unpaid.
- **The consent record stays**, and this is the one real conflict in the
  whole design. It is append-only — a database trigger refuses UPDATE and
  DELETE from every role including the application's — so a guardian
  cannot make their consent disappear, which is the entire point of it.

  A retention period that never expires would contradict TECHNICAL_SPEC
  §23 outright, so the trigger now permits **exactly one** change: the
  typed signature, user agent and hashed IP may be replaced with a
  redaction placeholder, and only once the relationship has ended *and*
  seven years have passed. Every other UPDATE and every DELETE is still
  refused. Verified against the live database, including that a signature
  cannot be replaced by a *different* name, and that a still-active
  guardianship blocks redaction however old the signature is.

  **The loss is real and counsel should weigh it:** after redaction the
  record no longer carries the signature. It shows that an identified
  account accepted a specific document, itemized, on a specific date — but
  not the name that account typed. Seven years is a proposal.

### 3.5 What is still an open question

- Whether seven years is right, especially for money held for minors.
- Whether any applicable deletion right overrides the two refusals in 3.2.
- Whether a minor reaching 18 should be able to request erasure of records
  created while they were 13–17 on different terms from an adult's. The
  aging-out path exists; no special deletion right is built for it.

---

## 4. One thing worth knowing about how this was built

Six times now, a capability has been declared in the design and never
wired up, with nothing failing in the meantime because absence is silent:
a service state that nothing could reach, a role nothing granted, a
guardian verification event nothing fired, an audit field recording the
wrong role, an account status column nothing read — which meant a
suspended account could do everything an active one could — and a
`closed` account status that no code path could ever set.

All six are fixed. The reason to mention it here is that **a capability
appearing in a design document is not evidence it works.** If counsel or
marketing needs to rely on a specific behaviour, ask and I will exercise
it against the real system rather than reading the code and assuming.
