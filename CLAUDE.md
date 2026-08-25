# CLAUDE.md — working agreement for the Count On Local repository

This file orients AI-assisted work in the Count On Local repo. Read the
linked documents before implementing anything non-trivial — this file is
a summary and a set of hard rules, not a replacement for them.

## What this project is

Count On Local is a responsive-web neighborhood microbusiness platform: a
provider (age 13+) launches a service page, sells **recurring** local
services to nearby households, and runs the route, customers, payments,
reviews, and growth from one dashboard. Owner: EDW Ventures.

Authoritative documents (V1 design baseline, dated 2026-08-24):

- [README.md](README.md) — package map and locked V1 decisions.
- [dev/PRD.md](dev/PRD.md) — authoritative product requirements.
- [dev/UX_UI_SPEC.md](dev/UX_UI_SPEC.md) — visual system, components, screens.
- [dev/TECHNICAL_SPEC.md](dev/TECHNICAL_SPEC.md) — architecture, integrations, jobs.
- [dev/DATA_MODEL.sql](dev/DATA_MODEL.sql) — reference PostgreSQL/PostGIS schema.
- [dev/API_CONTRACT.md](dev/API_CONTRACT.md) — API and webhook behavior.
- [dev/SAFETY_TRUST_POLICY.md](dev/SAFETY_TRUST_POLICY.md) — age, guardian, risk, privacy rules.
- [dev/QA_ACCEPTANCE.md](dev/QA_ACCEPTANCE.md) — release acceptance criteria.
- [dev/PRODUCT_DECISIONS.json](dev/PRODUCT_DECISIONS.json) — machine-readable locked decisions.
- [marketing/](marketing/) — brand guide, GTM, approved copy, flyer template.
- [prototype/index.html](prototype/index.html) — clickable reference prototype.

## Hard rules — do not violate without explicit owner sign-off

1. **Minors' privacy wins over convenience.** A provider's home address,
   school, exact age/DOB, private schedule, and live location are never
   public and never sent to analytics. Where privacy and convenience
   conflict for a minor provider, default to privacy and surface the
   tradeoff rather than deciding it.
2. **Provider min age 13; ages 13–17 cannot accept paid customers until
   the guardian relationship reaches `verified`.** Guardian state is a
   real state machine (`not_required`, `required_uninvited`, `invited`,
   `guardian_started`, `verified`, `revoked`, `expired`,
   `manual_review`), not a boolean. See SAFETY_TRUST_POLICY §2.
3. **The service catalog is a server-owned allowlist.** Providers never
   create categories, and provider free text can never widen the scope of
   an approved service. Prohibited categories in PRD §7 stay unavailable
   even on request.
4. **Money is integer minor units (cents), always.** Never floating-point
   dollars. Every money movement lands in an append-only ledger
   (charge / platform fee / provider earning / credit / refund / dispute /
   payout / adjustment) referencing its source entity and processor ID.
5. **Provider keeps the listed price — 0% provider fee.** Monetization is
   a customer platform fee (launch recommendation 15%, $1.00 minimum per
   cycle). The fee is configuration, never a hard-coded constant.
6. **Stripe is never the source of truth for scheduling.** Domain records
   (subscription, service_occurrence, ledger) stay processor-agnostic.
   All payment-changing operations use idempotency keys; webhooks verify
   signatures, de-duplicate by event ID, and never assume ordering.
7. **Authorization is enforced server-side, row-level.** Roles are
   additive permissions, not an `is_admin` flag. Client-side hiding is
   not authorization.
8. **Occurrences are generated on a rolling 8–12 week horizon**, extended
   daily by a background job. Never generate years of rows up front.
   Timestamps in UTC with IANA time zones, plus local-date semantics for
   the service date so DST can't shift a route.
9. **Every sensitive action is audit-logged** (guardian approval/
   revocation, publish state, admin address access, payout holds,
   refunds/credits above threshold, incidents, suspensions, role changes)
   with actor, reason code, and redacted before/after snapshots.
10. **Trust copy must be factually earned.** Only claims backed by an
    actual verification are allowed ("Guardian connected", "Identity
    verified"). Never imply a background check that was not performed.
11. **V1 is recurring-first, not a job board.** No open bidding, no
    customer job postings, no social feed, no provider subscription fee,
    no native-app requirement. One-time work exists only as an add-on to
    an approved provider service.
12. **Uploads are sanitized before storage**: content-type + magic-byte
    validation, EXIF stripped, private by default, authorized on every
    fetch.
13. **Gate/access codes are sensitive service data** — never in email
    subjects, push previews, logs, or analytics payloads.

## Product review triggers

Adding any of these requires an explicit owner + legal review before
implementation starts, not after: under-13 users, childcare, in-home
services by minors, live location, background checks, transportation,
eldercare/medication, employer-like shift assignment, insurance claims,
school partnerships involving student data, international launch.

## Recommended build sequence

Per README, do not jump ahead:

1. Auth, roles, age gate, guardian relationship.
2. Provider onboarding + Stripe connected-account onboarding.
3. Business/service builder and public storefront.
4. Customer address eligibility and subscription checkout.
5. Occurrence generation, completion, skip/credit, payout ledger.
6. Provider Today/Route experience.
7. Customer dashboard and pause/cancel controls.
8. Guardian dashboard and notifications.
9. Reviews, messaging, QR/flyer tools.
10. Admin trust/safety console, incidents, refunds, moderation.
11. Analytics, referrals, density prompts, launch polish.

## Launch gates outside the product

Design is complete; public launch still needs U.S. legal review of
marketplace terms and minor participation, payment-processor approval of
the final Connect setup, insurance review, state-by-state service
restriction review, and trademark/domain clearance for the Count On Local
name. Brand values live in centralized tokens
([assets/brand-tokens.css](assets/brand-tokens.css)) so a forced rename
does not change the UX or business model.

## Working on this repo

```
npm run dev        # Next.js dev server
npm test           # vitest, domain unit tests
npm run typecheck  # tsc --noEmit
npm run build      # production build
```

Copy `.env.example` to `.env.local` and fill it from the Supabase project.
`.env.local` is gitignored; never commit real keys and never paste them into
a chat transcript.

Layout:

- `src/domain/` pure rules -- age, guardian state machine, roles, gates. No
  I/O, no framework, fully unit-tested. Business rules go here, not in
  handlers.
- `src/server/` services that touch the database and write audit rows.
- `src/lib/supabase/` clients. `server.ts` is user-scoped and respects row
  level security; `admin.ts` bypasses it and is for the few paths that must.
- `src/app/api/` thin route handlers -- validate, authenticate, delegate.
- `migrations/` SQL. Domain invariants are repeated here as constraints on
  purpose.

## When in doubt

Prefer surfacing over guessing — especially for anything touching minor
safety, guardian state, money movement, address handling, the service
allowlist, new dependencies, or git history. Those need the owner's
explicit go-ahead.
