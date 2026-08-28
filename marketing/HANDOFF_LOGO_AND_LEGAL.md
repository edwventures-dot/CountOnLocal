# Handoff: logo, and Terms / Privacy / Safety Center

Two separate pieces of work for two different people. They do not depend
on each other and can run in parallel.

Owner: EDW Ventures. Everything below is for **countonlocal.com**.

---

# Part A — The logo (for art / design)

## What is wrong today

Three things disagree with each other:

| Where | What it shows |
| --- | --- |
| `assets/countonlocal-mark.svg` | A route-like **S** |
| `assets/countonlocal-logo.svg` | The same **S**, plus a wordmark |
| The live site header | A plain letter **C** in a rounded square |
| `marketing/BRAND_GUIDE.md` | Documents the mark as "a route-like `S`" |

The **S** is left over from the product's previous name, StreetStart. The
domain was taken, the product was renamed to Count On Local, and the mark
was never redrawn. The site header does not use either SVG — it draws a
literal capital C as a stopgap.

So the brand currently has no real mark.

## What we need

### 1. The mark (icon on its own)

Square, works at very small sizes. This is the piece that carries the
brand.

Used at:

- **38 × 38 px** in the site header — this is the real constraint, and it
  is small
- **32 × 32** and **16 × 16** as a browser favicon
- **180 × 180** as an Apple touch icon
- Large, on printed flyers a provider hands out door to door

The 16 px case is the honest test. If the mark needs more than two or
three shapes to read, it will not survive it.

### 2. The lockup (mark + wordmark)

Horizontal, mark on the left, "Count On Local" to the right. Used at the
top of the marketing site and on flyers.

Also supply a stacked version (mark above wordmark) for square spaces.

## Fixed constraints

**Colours are already set and must not change.** They live in
`assets/brand-tokens.css` and are used throughout the product:

| Name | Hex | Role |
| --- | --- | --- |
| Ink | `#14263A` | Primary dark, text, mark background |
| Lime | `#C7F34A` | Accent, the "go" colour |
| Cream | `#F6F3EA` | Page background |
| Coral | `#FF765C` | Sparingly, for a single point of emphasis |

**Type**: Manrope for headings and the wordmark, Inter for body. Both are
already in use.

**Existing geometry**, if it is worth keeping: the mark is drawn on a
160 × 160 canvas with a corner radius of 38 (about 24%). That soft-square
shape is fine to retain.

**From the brand guide, still applies:**

- Minimum clear space around the mark: the height of the mark's endpoint
  circle, on all sides
- Do not recolour the Lime mark with gradients

## One constraint worth reading twice

**Do not build a mark whose meaning depends on the letter C.**

Trademark and domain clearance for the name "Count On Local" is still
outstanding. If clearance fails, the product renames. The codebase is
built so that a rename is a token edit rather than a redesign, and the
mark should be too.

A mark that is literally a stylised C has to be thrown away if the name
changes. A mark about the *idea* — a local round, a route, a doorstep,
momentum on a street — survives it. That is also a better mark.

The previous name's S is exactly the failure mode we are recovering from
right now.

## What the mark is about

Count On Local is a neighbourhood microbusiness platform. A young person
— often 13 to 17 — runs a small recurring service on their own street:
bins to the curb, a dog walked, a yard tidied. Neighbours subscribe. The
provider walks a short round each week.

The brand idea in the guide is "starting locally and building momentum".

Useful ideas: a short route, a repeated round, a doorstep, a street,
something that comes back reliably. Avoid: anything that reads as a
babysitting service, anything corporate-gig-economy, anything that
implies vetting or background checks we do not perform.

## Deliverables

Replace these files, keeping the names and paths:

```
assets/countonlocal-mark.svg     square mark, 160 × 160 viewBox
assets/countonlocal-logo.svg     horizontal lockup, 880 × 180 viewBox
```

Plus new:

```
assets/countonlocal-logo-stacked.svg
assets/favicon.svg               single-colour-safe version
assets/favicon-32.png
assets/favicon-16.png
assets/apple-touch-icon.png      180 × 180
```

**SVG requirements**: no external fonts (convert the wordmark to paths),
no embedded raster images, no filters or gradients. These are inlined
into pages and printed on flyers.

Send working files (Figma or AI) as well as the exports.

## What happens after

I wire the new files into the site header, the flyer template, and the
favicon, and update the "route-like S" description in
`marketing/BRAND_GUIDE.md`. That is roughly an hour of work once the
assets land.

---

# Part B — Terms, Privacy, Safety Center (for legal, then marketing)

## This is not a copywriting job

These three documents need **US legal counsel**, and this product has
unusual characteristics that a template will get wrong:

- **Minors are sellers, not buyers.** Providers can be 13. They earn
  money and are paid out.
- **Money flows to a minor**, via a guardian who legally holds the payout
  account until the provider turns 18.
- **Guardian consent is a gating mechanism**, not a checkbox — a provider
  aged 13–17 cannot take a paying customer until the guardian
  relationship is verified, and a guardian can withdraw consent at any
  time, which immediately stops future charges.
- **We hold customer home addresses** and route a young person to them.

The marketing role here comes *after* counsel: reviewing the drafts for
readability and tone, and flagging anything that contradicts the copy we
already publish.

## The readability point, which matters more than usual

**A 13-year-old is a user of this product.** They are expected to
understand what they are agreeing to before running a business through
it, and their parent is expected to understand what they are consenting
to before approving it.

Terms that only a lawyer can parse are a genuine product problem here,
not a stylistic preference. Ask counsel for a plain-language summary
alongside the formal document, and treat the summary as a first-class
deliverable rather than a nicety.

## What the documents must match

The product already enforces these. The documents need to describe the
same thing, or one of them is wrong — and if they disagree, tell me and
I will change the code rather than have counsel describe behaviour that
does not exist.

**Age and consent**

- Minimum provider age 13. Under 13 is refused at signup and by a
  database constraint.
- Ages 13–17 require a verified parent or legal guardian before any paid
  work.
- Customers attest they are 18 or over at checkout.
- Guardian consent is revocable at any time, with immediate effect on new
  customers and future charges. Work already paid for is handed to
  support for resolution rather than dropped.

**Money**

- The provider keeps 100% of their listed price. There is no provider
  fee.
- The customer pays a platform fee on top — currently 15% with a $1.00
  minimum per billing cycle. This is configuration, so the documents
  should describe the mechanism rather than hard-code the number.
- Subscriptions are recurring, billed per cycle in advance.
- Customers can pause, skip a visit or cancel themselves. Cancelling
  refunds unspent cycle value; pausing does not refund but keeps credit.
- Payments and payouts run through Stripe. Stripe holds card details; we
  never see or store a card number.

**Privacy**

- A provider's home address, school, exact age or date of birth, and
  private schedule are never public and never sent to analytics.
- Customer addresses are visible only to that customer, the assigned
  provider, the linked guardian of a minor provider, and audited staff.
- Access codes and gate codes are restricted data: never in emails, push
  previews, logs or analytics.
- Public storefronts show a coarse area label — a neighbourhood name —
  never a map of where a provider works.

**What we do NOT claim**

This list matters. The product deliberately refuses to say these things,
and the documents must not reintroduce them:

- No background checks are performed. "Identity verified" refers only to
  Stripe's payment identity verification, and must never be described as
  a background check.
- No guarantee of safety, no "fully vetted", no "safe provider" as an
  absolute.
- Trust badges shown on a page are factual: "Guardian connected" appears
  only where a guardian is genuinely verified.

**Data and retention**

- Private messages between customer and provider are retained to a
  policy and then redacted, with the fact of the conversation preserved.
- Every sensitive staff action is audit-logged with the actor, their
  role, and a written reason.
- Counsel should specify retention periods, deletion rights, and how a
  minor's data is handled on account closure. We do not currently have
  those written down, and I need the answers to implement them.

## Safety Center

Distinct from Terms and Privacy. This is a plain-language public page for
parents and customers, covering:

- How the guardian relationship works and how to withdraw it
- What we do and do not verify — stated plainly, including that we do not
  run background checks
- What services are and are not allowed, and why
- How to report a concern, and what happens then (we have an incident
  workflow with response targets by severity)
- Where money goes and who holds the payout account for a minor

`dev/SAFETY_TRUST_POLICY.md` in the repo is the internal source for all
of this and should be given to whoever writes it.

## Where they will live

```
/terms
/privacy
/safety
```

The site footer currently reads: *"Terms, Privacy and the Safety Center
will be published before launch."* That sentence is a commitment with a
deadline attached, and it is one of the things blocking launch.

## Deliverable format

Markdown or a Google Doc. Plain structured text, not a PDF and not a
designed layout — I will build the pages so they match the rest of the
site and work on a phone.

Please include, for each document:

- An effective date
- A contact address for privacy and safety questions
- The plain-language summary described above

---

# What is blocked on this

Both pieces are on the launch checklist. The logo is cosmetic but
visible on every page and on every flyer a provider hands out. The legal
documents are a hard gate — the README lists US legal review of
marketplace terms and minor participation as a launch requirement, and
the footer already promises them.

Neither blocks further engineering. The product is otherwise feature
complete across every role.
