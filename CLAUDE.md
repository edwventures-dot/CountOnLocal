# CLAUDE.md — working agreement for the Count On Local repository

This file orients AI-assisted work in the Count On Local repo. It is a
summary and a set of hard rules. **On the `free-no-payments` branch it
overrides the documents it links to wherever they disagree** — see "Which
product this branch is" below, because most of them describe a different one.

## What this project is

Count On Local is free responsive-web software for running a small,
recurring, neighbourhood service. An adult provider lists what they do and
what they charge, neighbours subscribe, visits are scheduled on a walkable
route, and both sides see what is coming up. **Nobody is charged through it
and nobody is paid through it** — what a customer owes is settled with the
provider directly. Everyone using it is 18 or over. Owner: EDW Ventures LLC.

## Which product this branch is

There are two products in this repository, and it matters which one you are
working on.

- **`main`, tagged `v0-full-marketplace`** — parked. The full marketplace:
  providers aged 13+, a guardian state machine with in-person review, Stripe
  Connect payouts, a 15% customer platform fee, an append-only money ledger.
  Complete and tested, and waiting on legal clearance it does not have.
- **`free-no-payments`** — this branch. Everything above removed: no minors,
  no guardians, no payment processor, no ledger, no fees, no payouts.

The design documents were written for `main` and have not been rewritten.
They are still the right reference for anything this branch kept — the
catalog, scheduling, routes, storefronts, messaging, reviews, incidents,
retention, uploads — and **wrong** about age, guardians, payments, fees,
checkout, payouts, refunds and webhooks:

- [README.md](README.md) — package map; its locked decisions describe `main`.
- [dev/PRD.md](dev/PRD.md) — product requirements.
- [dev/UX_UI_SPEC.md](dev/UX_UI_SPEC.md) — visual system, components, screens.
- [dev/TECHNICAL_SPEC.md](dev/TECHNICAL_SPEC.md) — architecture, integrations, jobs.
- [dev/DATA_MODEL.sql](dev/DATA_MODEL.sql) — reference schema.
- [dev/API_CONTRACT.md](dev/API_CONTRACT.md) — API behaviour.
- [dev/SAFETY_TRUST_POLICY.md](dev/SAFETY_TRUST_POLICY.md) — risk and privacy rules; its age and guardian sections do not apply here.
- [dev/QA_ACCEPTANCE.md](dev/QA_ACCEPTANCE.md) — acceptance criteria.
- [dev/PRODUCT_DECISIONS.json](dev/PRODUCT_DECISIONS.json) — locked decisions for `main`.
- [marketing/](marketing/) — brand guide, copy, flyer template.
- [prototype/index.html](prototype/index.html) — clickable prototype.

## Hard rules — do not violate without explicit owner sign-off

1. **Adults only, and we never ask for a date of birth.** Providers and
   customers each confirm they are 18+ through an itemised attestation
   (`src/domain/consent.ts`), stored as a consent record with the exact
   wording shown. Do not add a DOB field: FTC guidance treats receiving a
   DOB that shows a user is under 13 as actual knowledge under COPPA, so
   asking creates an obligation that not asking does not.
2. **Count On Local never handles money.** No payment processor, no card on
   file, no ledger writes, no platform fee, no payouts, no refunds. A price
   is information, stored as integer cents (`src/domain/pricing.ts`) and
   capped at $50 per visit as a definition of what the product is for. An
   integration test fails if subscribing ever writes a ledger row.
3. **The service catalog is a server-owned allowlist.** Providers never
   create categories, and provider free text can never widen the scope of
   an approved service. Prohibited categories stay unavailable on request.
4. **Collect the least, and protect what is held.** Home addresses, access
   notes, private schedules and live location are never public and never
   sent to analytics. Analytics is an allowlist of fields, and no analytics
   vendor is connected. Where privacy and convenience conflict, choose
   privacy and surface the tradeoff.
5. **Gate and access codes are sensitive service data** — never in email
   subjects, notification previews, logs or analytics payloads.
6. **Authorization is enforced server-side, row-level.** Roles are additive
   permissions, not an `is_admin` flag. Client-side hiding is not
   authorization.
7. **Occurrences are generated on a rolling horizon** (currently 10 weeks),
   extended daily by a background job. Never generate years of rows up
   front. Timestamps in UTC with IANA time zones; service dates are civil
   dates (`src/domain/calendar.ts`) so DST cannot shift a route.
8. **Every sensitive action is audit-logged** — publish state, staff access
   to a customer address, incidents, strikes, suspensions and bans, role
   changes, account closure — with actor, reason code and redacted
   before/after snapshots.
9. **Every claim a person can read must be true.** No trust badges exist on
   this branch: never imply a guardian, an identity check or a background
   check, and never imply the app takes or holds payment. This covers the
   storefront, dashboards, emails and error messages, not only the legal
   pages — the legal-page test scans only `src/content/legal.ts`.
10. **Recurring-first, not a job board.** No open bidding, no customer job
    postings, no social feed, no native-app requirement. One-time work
    exists only as an add-on to an approved service.
11. **Uploads are sanitized before storage**: content-type and magic-byte
    validation, EXIF stripped, private by default, authorized on every fetch.

## Product review triggers

Adding any of these requires an explicit owner and legal review before
implementation starts, not after: **anyone under 18** (restore from
`v0-full-marketplace` rather than rebuilding), **any payment handling, fee,
payout or payment processor**, **advertising or third-party tracking** (it
would contradict the privacy notice's "we do not sell your information"),
childcare, in-home services, live location, background checks,
transportation, eldercare or medication, employer-like shift assignment,
insurance claims, school partnerships involving student data, international
launch.

## Known debts on this branch

- **It shares a Supabase project with `main`.** Two migrations here weaken
  that schema for `main` as well: `0045` made `provider_profiles.date_of_birth`
  and `guardian_state` nullable, and `0046` dropped the rule that an active
  subscription needs a card on file. Before anyone other than the owner uses
  this branch, it needs its own project. Do not add further schema changes
  that loosen `main` without saying so.
- **Dormant tables and generated types.** `ledger_entries`,
  `guardian_relationships` and other payment and guardian tables still exist,
  and `src/lib/supabase/types.ts` still describes them. Nothing on this branch
  should write to them.
- **`npm run test:payout:live` has nothing to run** — its tests went with payouts.
- **The legal pages are drafts** with eight sections waiting on counsel.

## What is built

Every surface has a working implementation: sign-up with adult attestation,
provider onboarding, business and service builder, public storefront, address
eligibility and `/subscribe`, occurrence generation with completion and skips,
the provider's Today route, the customer's services page with pause and
cancel, notifications, reviews, messaging, QR codes and flyers, the trust and
safety console, retention and account closure, and density prompts.

Access is controlled at two levels: the prelaunch gate (`src/lib/prelaunch.ts`)
decides which paths are public, and invite-only signup — a trigger on
`auth.users` from migration `0043`, switched with `npm run pilot` — decides who
can create an account. `@example.com` addresses are always allowed so the test
suite can run.

## Launch gates outside the product

Legal review of the terms and privacy notice (now an ordinary small-website
scope), a decision on liability insurance (none is held), trademark and
domain clearance for the Count On Local name, and web-filter categorization —
FortiGuard currently blocks the domain on filtered networks. Brand values live
in [assets/brand-tokens.css](assets/brand-tokens.css) so a forced rename does
not change the UX.

## Working on this repo

```
npm run dev               # Next.js dev server
npm test                  # vitest, unit tests
npm run typecheck         # tsc --noEmit
npm run build             # production build
npm run test:integration  # service tests against the live Supabase project
npm run test:http         # HTTP tests; needs the dev server running
npm run db:verify:rls     # row level security checks
npm run migrate           # apply pending migrations (migrate:status to list)
npm run pilot -- status   # invite-only signup: status | on | off | list | add | remove
npm run waitlist          # read the waitlist
```

Copy `.env.example` to `.env.local` and fill it from the Supabase project.
`.env.local` is gitignored; never commit real keys and never paste them into
a chat transcript. Integration tests create and delete real users in the
shared project — use `@example.com` addresses.

Layout:

- `src/domain/` pure rules — catalog, gates, roles, schedule, occurrences,
  skips (`credit.ts`), calendar dates, pricing, consent documents,
  retention, jurisdiction. No I/O, no framework, fully unit-tested. Business
  rules go here, not in handlers.
- `src/server/` services that touch the database and write audit rows.
- `src/lib/supabase/` clients. `server.ts` is user-scoped and respects row
  level security; `admin.ts` bypasses it and is for the few paths that must.
- `src/app/api/` thin route handlers — validate, authenticate, delegate.
- `migrations/` SQL. Domain invariants are repeated here as constraints on
  purpose.

## How to know something works

Passing tests have repeatedly not been enough here. The subscribe flow was
unreachable, a consent screen rendered as one paragraph, and a storefront
claimed "Payments handled securely" — all with a green suite. So:

- **Load the page.** Anything a person sees is verified in the running app,
  not by reading the component.
- **A `className` is an unchecked string.** `src/components/__tests__/classNames.test.ts`
  fails if a component names a class missing from `globals.css`; keep it passing.
- **Do not pin tests to a calendar date as "the future".** A fixed date
  silently becomes the past. Use a time relative to `Date.now()` when the
  test interacts with the real clock.

## When in doubt

Prefer surfacing over guessing — especially for anything touching address
handling, the service allowlist, anything that would move money, anyone
under 18, schema changes to the shared database, new dependencies, or git
history. Those need the owner's explicit go-ahead.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
