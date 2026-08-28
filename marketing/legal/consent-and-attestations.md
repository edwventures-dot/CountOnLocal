# Consent & Attestations — Guardian consent + Customer attestation

> **DRAFT — not legal advice.** Written from the PRD + Safety & Trust Policy in plain
> language, with **itemized, check-each-point** acknowledgment before signing. This is the
> informed-consent design; a US attorney should review the final wording before real use.
> Build note: each of these is a **clickwrap e-signature** (ESIGN / UETA — no wet ink).
> The app must **store the signed record immutably**: signer identity (verified), which
> minor, the exact text **version + hash**, the **timestamp**, the verification method,
> and that it is revocable. See the dev handoff.

---

# A. Guardian Consent (provider aged 13–17)

**Please read each point and check the box to confirm you understand it.** You're being
asked to let **{{minor_name}}** run a small local service business through Count On Local.
These are real things you're agreeing to — we want you to know exactly what.

- [ ] **My teen will run a business and earn money.** {{minor_name}} sets a price and keeps
  100% of it. The customer pays Count On Local a small platform fee on top.
- [ ] **I hold the money until they turn 18.** Because {{minor_name}} is under 18, the payout
  account is in my name and I receive and oversee the payouts until they turn 18.
- [ ] **My teen may go to a customer's address to do the work.** After someone subscribes,
  Count On Local shares that customer's service address with {{minor_name}} — and with me — so
  the work can happen. The work is outdoor, approved tasks only (below).
- [ ] **There is an in-app messaging system.** {{minor_name}} can exchange messages with adult
  customers inside Count On Local, tied to a job. It has blocking and reporting and stricter
  controls for minors — but I understand this communication exists.
- [ ] **Count On Local does NOT run background checks — on anyone.** "Identity verified" means
  only that a payment identity was confirmed through Stripe. Count On Local vets no one. This is
  a tool for neighbors who already know and trust each other, and **choosing who my teen works
  with is my responsibility, not Count On Local's.**
- [ ] **My teen's listing is PRIVATE by default.** It can be reached only by a link or QR code
  we choose to share. It will **not** appear in public search unless I separately sign a Public
  Listing Consent — and even then it shows only business info, never a home address, school,
  birth date, or last name.
- [ ] **My teen may only offer approved outdoor tasks** — trash cans to the curb, dog walking,
  yard cleanup, watering, exterior car wash, and similar. They may **not** use ladders, power
  tools, or chemicals, may **not** enter anyone's home, and may **not** do childcare, driving,
  or any prohibited work.
- [ ] **My teen must personally do the work.** Sending someone else in their place (a friend or
  sibling) is not allowed and can get the account banned.
- [ ] **My teen will upload completion photos, and customers can leave public reviews.** Photos
  have location data removed and are private by default; reviews build a public reputation.
- [ ] **I can withdraw this consent at any time.** If I do, the business is paused immediately,
  no new customers can subscribe, and future charges stop. Work already paid for is handed to
  support to resolve safely.
- [ ] **I've read the [Safety Center](/safety), and I know Count On Local is not an emergency
  service.** In an emergency I will call local emergency services (911). I know how to report a
  concern.

**Sign**
> I am the parent or legal guardian of **{{minor_name}}**. I have read and understood each point
> above. I consent to {{minor_name}} operating a business through Count On Local under these terms.

`{{guardian_full_legal_name}}`  — typing your name here is your electronic signature.
**[ I agree ]** → records your name, the date and time, and the version of this consent.

---

# A2. Public Listing Consent (separate, optional)

Only shown if a guardian chooses to make the teen findable in search.

- [ ] I understand that by default my teen is reachable **only** by the link/QR we share.
- [ ] I choose to make my teen's **business listing** appear in Count On Local's public search.
- [ ] I understand the public listing shows business info only — **never** a home address,
  school, birth date, last name, or exact schedule.
- [ ] I understand I can turn this off at any time, which removes the listing from search.

`{{guardian_full_legal_name}}` — **[ I agree ]** *(stored as a separate signed record.)*

---

# B. Customer Attestation (at checkout, before first paid service)

- [ ] **I am 18 or older.**
- [ ] **I understand Count On Local does NOT run background checks.** I am choosing to hire
  someone in my neighborhood I know and trust; vetting them is my responsibility.
- [ ] **I understand the provider may be a teenager (13–17)** whose parent or legal guardian has
  approved their business.
- [ ] **I will give an accurate service address**, and for dog walking, honest information about
  my dog (size, leash/harness, and any bite history).
- [ ] **I understand there is in-app messaging** and how to block or report.
- [ ] **I understand Count On Local is not an emergency service.**

`{{customer_full_name}}` — **[ I agree ]** *(stored as a signed record with timestamp + version.)*
