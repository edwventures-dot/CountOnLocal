# StreetStart - Complete Product Design Handoff

**Owner:** EDW Ventures  
**Design baseline:** Final V1 product design  
**Date:** 2026-08-24  
**Product type:** Responsive web marketplace + microbusiness operating system  
**Launch audience:** Ages 13+ providers and local household customers in the United States

## Product in one sentence

StreetStart lets a young person launch a professional neighborhood service page, sell recurring services to nearby customers, and run the route, customers, payments, reviews, and growth of that microbusiness from one dashboard.

## Core differentiation

StreetStart is not another "post a job and wait for applicants" marketplace. The provider starts the business first. Customers discover or scan the provider's page and subscribe to a recurring service.

The product is deliberately optimized for tiny, repeatable neighborhood services that are often too small for established service companies: trash-can curb service, dog walking, manual yard cleanup, watering, porch/package help, and similar work.

## Locked V1 decisions

- Brand used throughout the design: **StreetStart**.
- Primary tagline: **Start a business where you live.**
- Product thesis: **storefront + subscription + route operations**, not an open bidding board.
- Web-first responsive product. No app install is required to discover, subscribe, or manage a service.
- Providers must be 13 or older.
- Ages 13-17 require a verified parent/legal guardian relationship before paid services go live.
- Public profiles never expose a provider's home address, school, exact age, private schedule, or live location.
- The V1 service catalog is allowlist-based. High-risk categories are unavailable even if a provider asks to add them.
- Provider sets the list price and keeps the listed service amount. StreetStart monetizes with a customer platform fee.
- Weekly microservices are billed in 4-week cycles to avoid destroying unit economics with repeated card fees.
- V1 is recurring-first. One-time add-ons are allowed only as extensions of an approved provider service; no general job-posting marketplace.
- Provider businesses have shareable public pages and built-in printable QR flyers.
- Route density is a first-class product metric and growth mechanic.

## Package map

### Product / development
- `dev/PRD.md` - authoritative product requirements.
- `dev/UX_UI_SPEC.md` - visual system, components, responsive rules, and screen-by-screen requirements.
- `dev/TECHNICAL_SPEC.md` - recommended architecture, integrations, security, background jobs, and API surface.
- `dev/DATA_MODEL.sql` - implementation-oriented PostgreSQL data model.
- `dev/API_CONTRACT.md` - API and webhook behavior.
- `dev/SAFETY_TRUST_POLICY.md` - age, guardian, service risk, privacy, messaging, and incident rules.
- `dev/QA_ACCEPTANCE.md` - release acceptance criteria and high-risk test cases.
- `dev/PRODUCT_DECISIONS.json` - machine-readable summary of locked decisions and flags.

### Marketing
- `marketing/BRAND_GUIDE.md` - brand identity, messaging, voice, audience positioning, and visual tokens.
- `marketing/GO_TO_MARKET.md` - launch strategy, density model, channels, referrals, partnerships, and metrics. *(internal - not included in this repository)*
- `marketing/COPY_DECK.md` - approved V1 copy for the site, onboarding, transactional UI, notifications, and flyers.
- `marketing/flyer_template.html` - printable provider QR flyer template.

### Research
- `research/COMPETITOR_SNAPSHOT.md` - current competitive landscape and StreetStart positioning. *(internal - not included in this repository)*
- `research/SOURCES.md` - current sources used for product/compliance assumptions.

### Prototype / assets
- `prototype/index.html` - zero-install clickable desktop/mobile reference prototype.
- `assets/streetstart-logo.svg` - horizontal logo.
- `assets/streetstart-mark.svg` - standalone mark.
- `assets/brand-tokens.css` - implementation tokens.

## Recommended development sequence

1. Auth, roles, age gate, guardian relationship.
2. Provider onboarding and Stripe connected-account onboarding.
3. Business/service builder and public storefront.
4. Customer address eligibility and subscription checkout.
5. Occurrence generation, completion, skip/credit, and payout ledger.
6. Provider Today/Route experience.
7. Customer dashboard and pause/cancel controls.
8. Guardian dashboard and notifications.
9. Reviews, messaging, QR/flyer tools.
10. Admin trust/safety console, incidents, refunds, and moderation.
11. Analytics, referrals, density prompts, and launch polish.

## External launch gates

The product design is complete, but public launch still requires normal non-design approvals: U.S. legal review of marketplace terms and minor participation, payment-processor approval for the final Connect setup, insurance review, state-by-state service restrictions if expansion requires them, and trademark/domain clearance for StreetStart. If a legal name change is required, the product uses centralized brand tokens so a rename does not change the UX or business model.
