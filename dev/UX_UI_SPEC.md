# Count On Local UX / UI Specification

## 1. Experience direction

Count On Local should feel like a modern small-business product that happens to be accessible to teenagers, not a children's app and not a corporate contractor marketplace.

Visual adjectives:

- capable;
- energetic;
- local;
- clean;
- optimistic;
- practical;
- trustworthy.

Avoid:

- school-themed graphics;
- cartoon mascots;
- childish copy;
- gig-economy "grind" aesthetics;
- dark patterns;
- displaying minors as marketplace inventory.

## 2. Brand tokens

### Colors

- Ink: `#14263A` - primary text, header, trust.
- Lime: `#C7F34A` - primary action/accent.
- Cream: `#F6F3EA` - page background.
- White: `#FFFFFF` - cards/surfaces.
- Coral: `#FF765C` - secondary accent and limited attention states.
- Blue: `#3B82F6` - links/information.
- Green: `#16875B` - success.
- Amber: `#B7791F` - warning.
- Red: `#C43E3E` - destructive/errors.
- Muted text: `#607080`.
- Border: `#DDE3E6`.

### Typography

Web font recommendation:

- Headings: Manrope 700/800.
- Body/UI: Inter 400/500/600.
- Fallback: system sans-serif.

Do not rely on custom font files for core usability.

### Shape

- Card radius: 18px.
- Input/button radius: 12px.
- Pills: full radius.
- Shadow: subtle; most hierarchy should come from spacing/borders, not heavy shadows.

### Spacing

Base unit: 4px.
Common scale: 4, 8, 12, 16, 24, 32, 48, 64.

## 3. Logo direction

The Count On Local mark is a rounded route/forward symbol built from an `S` path and two route endpoints. It should communicate "start here, move forward" without using a map pin that implies a provider's exact location.

Logo usage:

- dark wordmark on cream/white;
- white wordmark on Ink;
- Lime mark may be used as the app/favicon accent;
- do not place the mark inside children's iconography.

## 4. Global responsive layout

### Desktop

- max content width: 1200px;
- public marketing header: logo left, Discover / How it works / Safety center, right-side login and CTA;
- app shell: 248px left navigation + flexible content;
- core forms: 640-760px readable width;
- dashboards may use a 12-column grid.

### Mobile

- 16px outer gutter;
- provider/customer app uses bottom navigation for 4 primary destinations plus More;
- sticky bottom CTA on storefront/checkout where useful;
- avoid horizontal tables; convert to cards/rows.

### Breakpoints

Suggested: 640 / 768 / 1024 / 1280 px. Exact framework breakpoints may differ if behavior remains equivalent.

## 5. Accessibility baseline

- WCAG 2.2 AA target.
- All text/actions usable at 200% browser zoom.
- Keyboard operation for full web flow.
- Visible focus state.
- Minimum 44x44px touch targets for primary mobile controls.
- No color-only status communication.
- Form error summary + inline messages.
- Motion reduced under `prefers-reduced-motion`.
- Maps cannot be the only way to define/read a service area.

## 6. Core components

### Primary button
Lime background, Ink text, 48px standard height. Copy begins with a verb: `Start my business`, `Check my address`, `Subscribe`.

### Secondary button
White/transparent with Ink border.

### Destructive action
Text or outlined Red by default. Filled Red only for final destructive confirmation.

### Service card
Contains service icon, service name, one-line promise, provider list price, frequency, service day, availability, CTA.

### Trust badge
Small outlined pill. Only rendered from server-verified facts. Examples:

- Identity verified
- Guardian connected
- Payments protected
- 12 completed services

Do not invent vague badges such as "Safe teen".

### Money display
Provider price is visually primary. Customer platform fee is visible at checkout and billing detail, not hidden inside a misleading service price.

### Status chip
Scheduled, Due today, Completed, Credited, Issue, Paused, Payment failed.

### Route stop
Large ordinal, customer first name/initial preference, masked address until provider opens the active stop, service name, instructions badge, Complete button.

### Empty state
One action, one explanation, no generic illustration requirement.

## 7. Public landing page

### Header
Count On Local logo.
Links: Find help, Start a business, How it works, Safety.
CTA: Start a business.

### Hero
Eyebrow: `Neighborhood businesses start small.`
Headline: `Start a business where you live.`
Body: `Create a real service page, get recurring customers nearby, and run the whole thing from one simple dashboard.`
Primary CTA: `Start my business`
Secondary CTA: `Find local help`

Hero visual: storefront mockup paired with a mini route/revenue card, not stock photography of smiling teenagers.

### Social proof strip
Use real platform metrics only after launch. Prelaunch uses category statements, not fake counts.

### How it works - provider
1. Pick what you do.
2. Publish your page.
3. Get neighbors subscribed.
4. Run your route and get paid.

### Customer section
Headline: `Good help is closer than you think.`
Show 3-4 example recurring services.

### Parent/guardian section
Headline: `They run the business. You stay connected.`
Explain guardian approval, privacy, service controls, and activity visibility.

### Footer
Safety Center, Terms, Privacy, Accessibility, Contact, Provider Rules, Customer Rules.

## 8. Public provider storefront

Order:

1. compact site header;
2. business hero;
3. business trust strip;
4. active service cards;
5. address eligibility input;
6. About;
7. service area label/map approximation;
8. reviews;
9. FAQs/cancellation;
10. Count On Local trust/footer.

Hero example:

`Jake's Bin Service`
`Trash cans handled every Tuesday so you do not have to think about them.`
`Cypress-area example neighborhood`
`From $3/week`
`[Check my address]`

Provider profile photography is optional. Business logos/avatars should be first-class.

## 9. Address eligibility screen

Never reveal the provider's zone before the customer enters their own address in a way that enables reverse-engineering a minor's home.

States:

- checking;
- eligible - show service and start date;
- outside area - allow notify-me or browse alternatives;
- capacity full - waitlist;
- ambiguous address - correction flow.

## 10. Checkout

Desktop: 2-column, service summary left / checkout right.
Mobile: single flow with sticky final CTA.

Required summary:

- provider business;
- service;
- address;
- frequency;
- expected service day/window;
- provider price;
- Count On Local platform fee;
- billing cadence;
- charge today;
- next charge;
- pause/cancel sentence.

For weekly service, phrase as:

`$3/week for service`  
`Billed every 4 weeks`

Do not present `$13.80/month` because 4-week billing is not a calendar month.

## 11. Provider onboarding screens

1. Welcome - "What could you do for your neighbors every week?"
2. Date of birth.
3. Guardian connection when needed.
4. Choose service.
5. Business name.
6. What exactly is included?
7. Price/frequency.
8. Schedule.
9. Service area.
10. Capacity.
11. Page branding.
12. Payout setup.
13. Review requirements.
14. Preview/publish.
15. Growth launch screen - link + QR flyer.

Use a progress indicator by meaningful stage, not `Step 7 of 15` anxiety.

Stages: Basics / Service / Area / Get paid / Publish.

## 12. Provider Today dashboard

Top card:

- `Tuesday route`
- 18 stops
- `$54` provider earnings represented by today's service value
- estimated route length/time
- `Start route`

Below:

- route stops;
- alerts/changes;
- quick add vacation;
- completion progress.

At completion:

`18 of 18 done` + earnings card + optional ask to share/refill capacity.

## 13. Provider Grow dashboard

This screen is strategically important.

Cards:

### Route density
`8 customers in Oak Ridge`  
`4 open Tuesday spots nearby`

### Flyer
Customize business/service/price, generate printable PDF/HTML and QR.

### Share
Copy page link, text/share sheet.

### Referral
Provider-specific code. V1 recommendation: customer receives first-cycle platform-fee discount; provider receives a platform-fee-sponsored bonus after qualifying paid occurrence.

### Expansion prompt
Only appear when route has healthy capacity utilization. Avoid encouraging geographic sprawl too early.

## 14. Customer dashboard

Hero: next scheduled service.

Cards:

- Next service
- Active subscriptions
- Credits
- Messages

Subscription detail offers:

- Skip next service;
- Pause date range;
- Change instructions;
- Payment method;
- Cancel subscription;
- Report issue.

## 15. Guardian dashboard

Header: provider business identity + current status.

Priority content:

- Next route/date;
- new customers since last visit;
- service area;
- approved categories;
- payout status;
- alerts/incidents;
- Pause business.

Guardian controls should look like business supervision, not parental-control surveillance software.

## 16. Admin UX

Admin is desktop-first.

Queues:

- identity/guardian exceptions;
- content moderation;
- service risk exceptions;
- payment/fraud;
- customer issues;
- safety incidents.

Every high-impact action should show prior state, proposed state, reason, actor, and timestamp.

## 17. Confirmation and error copy rules

- Tell the user what happened.
- Tell them what happens next.
- Do not blame payment processors or other internal vendors.
- For minors, do not expose sensitive reasons to customers.

Good: `This business is temporarily unavailable. Your active subscription has been paused and you will not be charged for missed service.`

Bad: `Provider failed KYC.`

## 18. Motion

Use motion only for:

- progress;
- successful publish/completion;
- route completion;
- drawer/modal transitions.

No gamified confetti for payments involving minors by default. Small celebratory motion on first business publish is acceptable.
