# StreetStart Product Requirements Document

## 1. Product definition

StreetStart is a neighborhood microbusiness platform. A provider creates a small local service business, publishes a professional service page, acquires customers through a share link, QR flyer, or StreetStart discovery, and manages recurring service from a provider dashboard.

The primary unit is not a job posting. It is a **provider-owned recurring service plan**.

Example:

- Business: Jake's Bin Service
- Service: Trash cans curb to house
- Frequency: Weekly
- Provider price: $3/week
- Billing: $12 every 4 weeks plus StreetStart platform fee
- Service day: Tuesday
- Capacity: 30 addresses
- Area: provider-defined neighborhood zone

## 2. Problem

Young providers can already text neighbors, use Venmo, make a social post, or list on a generic gig platform. What they lack is a single simple system for:

- looking credible;
- taking recurring payments;
- controlling which homes they serve;
- remembering recurring work;
- planning dense neighborhood routes;
- handling pauses and vacations;
- keeping customers informed;
- getting reviews;
- generating flyers and referral links;
- involving a guardian when required;
- seeing whether a tiny hustle is turning into a real business.

Customers have the inverse problem: local help exists, but it is fragmented across neighborhood posts, text messages, cash, and informal referrals.

## 3. Product goals

### G1 - Launch a business in under 10 minutes
A qualified provider should be able to go from account creation to a publishable service page in one guided session.

### G2 - Make recurring service the default
All approved services should support a recurring plan when the service naturally repeats. The UI should sell reliability and routine rather than isolated gigs.

### G3 - Protect neighborhood density
Providers choose tight service areas and capacity. Growth prompts favor filling a route before expanding geography.

### G4 - Be safe enough for guardian participation
The system must make guardian oversight obvious and useful without making a teenager's public page feel childish.

### G5 - Let providers act like owners
The provider chooses business name, service, price, schedule, capacity, description, and branding within platform rules.

## 4. Non-goals for V1

- No open customer job board.
- No bidding or provider race-to-the-bottom pricing.
- No employer/employee time clock.
- No provider live-location broadcasting.
- No customer access to a minor's home address, school, or private personal contact information.
- No licensed trades.
- No transportation of people.
- No childcare, eldercare, medical assistance, weapons-related work, alcohol/tobacco delivery, hazardous chemicals, roof/ladder work, or other launch-prohibited categories.
- No provider subscription fee.
- No native mobile app requirement.
- No social feed.

## 5. User roles

### Provider
Age 13+. Creates and operates a microbusiness.

### Guardian
Required for a provider aged 13-17. Verifies relationship/consent as required by payments and StreetStart policy. Can review services, service areas, scheduled work, incidents, and payout status.

### Customer
Adult account holder who subscribes to a provider service for one or more service addresses.

### Admin
StreetStart operations/trust-and-safety staff.

### Support
Restricted admin role for customer/provider assistance without unrestricted access to sensitive identity data.

## 6. Age model

- Under 13: registration blocked.
- 13-17: provider account can draft a business page but cannot accept paid customers until guardian onboarding is complete.
- 18+: independent onboarding.
- Customer checkout: 18+ attestation in V1.
- Public provider age display: never show exact DOB or exact age. Optional labels are "Teen provider" or "Adult provider" only if needed for trust messaging; default public UI does not display age.

## 7. V1 service catalog

StreetStart uses a centrally managed catalog. Providers do not create arbitrary categories.

### Launch-approved categories

1. Trash/recycling can curb service
   - house to curb
   - curb to house
   - both directions
2. Dog walking
   - configurable dog count and provider limits
3. Dog waste pickup
4. Manual yard cleanup
   - raking
   - hand weeding
   - sticks/debris pickup
5. Outdoor plant watering
6. Porch/package move-in
   - exterior/porch only
7. Car wash - exterior hand wash
8. Seasonal exterior cleanup
   - decorations handling at ground level only
   - no ladders
9. Sports/basic skill practice
   - non-contact, public/outdoor setting; no unsupervised childcare representation
10. Tutoring
   - remote or approved public/common-area setting; V1 can launch disabled by market if desired

### Explicitly prohibited at launch

- driving or transporting customers;
- childcare/babysitting;
- elder/medical care;
- overnight house sitting;
- inside-home cleaning for minor providers;
- entering a customer's home for minor providers except a future separately approved category;
- roofing, ladders, tree climbing;
- powered saws, chainsaws, heavy machinery;
- licensed electrical, plumbing, HVAC, pesticide, structural, or regulated work;
- firearm/weapon work;
- alcohol, tobacco, cannabis, controlled substances;
- handling financial accounts, legal documents, medications, or personal credentials;
- animal services involving aggressive animals, medical treatment, breeding, or exotic animals;
- any sexual/adult service;
- any service manually blocked by Trust & Safety.

## 8. Business creation flow

1. Create account / sign in.
2. Enter date of birth.
3. If 13-17, collect guardian email/mobile and begin guardian workflow.
4. Choose a service category.
5. Name the business. Suggested naming patterns are optional; do not auto-insert "kid" or "teen".
6. Select service variants.
7. Set provider list price and frequency.
8. Set service day/window.
9. Draw or select service area.
10. Set route capacity.
11. Add business description, logo/avatar, and optional proof examples.
12. Complete payout onboarding.
13. Complete guardian approval if applicable.
14. Preview page.
15. Publish.
16. Generate share link and QR flyer.

The system stores an unpublished draft throughout the flow.

## 9. Public storefront requirements

URL pattern: `streetstart.com/{slug}` with service deep links such as `streetstart.com/{slug}/{service-slug}`.

The page must show:

- business name and provider first name or approved display name;
- logo/avatar;
- short business promise;
- broad service area label such as neighborhood/city;
- trust badges that reflect actual verification state;
- service cards;
- provider list price normalized to the service frequency;
- billing cadence shown separately;
- service day/window;
- capacity/availability state;
- review score/count after minimum review threshold;
- service details and exclusions;
- pause/cancel terms;
- CTA: Check my address;
- address eligibility before checkout;
- no exact provider location.

## 10. Customer subscription flow

1. Open provider service page.
2. Enter service address.
3. Backend geocodes address and verifies it is within provider service area.
4. Choose plan/variant.
5. Choose earliest eligible start date.
6. Review service instructions and customer obligations.
7. Add notes limited to service scope.
8. Create/login to customer account.
9. Add payment method.
10. Review provider price, platform fee, billing cadence, and total.
11. Confirm subscription.
12. Receive confirmation and next-service date.

Full service address becomes available only to the assigned provider and guardian-linked operational views after purchase.

## 11. Recurring schedule engine

A subscription generates **service occurrences**.

Each occurrence contains:

- subscription ID;
- scheduled service date;
- provider-defined service window;
- service address;
- status;
- customer instructions;
- route position;
- proof-of-completion data;
- credit/refund state.

Statuses:

`scheduled -> due_today -> started(optional) -> completed -> settled`

Alternate terminal paths:

- `provider_skipped -> customer_credit`
- `customer_skipped -> no_service` (credit behavior depends on notice window)
- `issue_reported -> review -> resolved/refunded/settled`
- `canceled` for future occurrences after subscription cancellation.

## 12. Billing model

### Provider promise
**Set your price. Keep your price.**

V1 provider platform fee: 0% of listed service price.

### Customer platform fee
Recommended launch fee: **15% of service subtotal** with a configurable minimum of **$1.00 per billing cycle**.

The fee is a configuration value, not hard-coded.

### Billing cadence
Recurring services priced weekly are normally charged every 4 weeks as one cycle.

Example:

- provider list price: $3/week;
- 4-week service subtotal: $12.00;
- StreetStart platform fee at 15%: $1.80;
- customer charge: $13.80 before any required tax;
- provider ledger credit: $12.00.

The platform pays card/Connect infrastructure costs from its platform fee unless the finance/legal implementation chooses a different disclosed structure.

### Credits
A provider-canceled occurrence automatically creates a proportional service credit against the customer's next bill. If the subscription ends first, the balance is refundable.

## 13. Provider dashboard

Primary navigation:

- Today
- Customers
- Services
- Money
- Grow
- Reviews
- Messages
- Settings

### Today
The default provider home.

Shows:

- expected earnings for today's route;
- stops due;
- route order;
- service-specific instructions;
- completion action;
- issue action;
- route completion progress.

### Customers
List and map-safe summary of active subscribers. Filters by service, day, status, and neighborhood cluster.

### Services
Create/edit approved services, prices, capacity, schedule, vacation blocks, and service area.

### Money
Gross provider earnings, pending, available, paid, credits, refunds, and payout timeline. Avoid the word "profit" unless costs are actually tracked.

### Grow
QR flyer generator, share link, referral code, density score, nearby open capacity, and suggested expansion.

### Reviews
Review history and provider response capability under moderation rules.

## 14. Route density system

StreetStart should optimize for **revenue per local route**, not total map radius.

Provider metrics:

- active customers per route day;
- route miles / estimated walking distance;
- revenue per route hour estimate;
- capacity utilization;
- clusters with open capacity;
- repeat/retention rate.

Growth prompt examples:

- "You already serve 8 homes in Oak Ridge on Tuesday. Add 4 more nearby customers before expanding your area."
- "This street has 3 customers and 7 open service slots. Print a street-specific flyer."

Public social proof can say "Popular nearby" or "Serving 8 homes in this area" only when privacy thresholds are met. Never expose which houses subscribe.

## 15. Guardian dashboard

For 13-17 providers, guardian can:

- see active StreetStart business name and public page;
- see approved services;
- approve or revoke service-category permissions;
- see service-area boundaries;
- see scheduled dates and customer addresses tied to actual jobs;
- receive new-customer and incident alerts;
- see payout status;
- pause the provider business immediately;
- access report/support tools.

Guardian cannot silently read unrelated private drafts or export customer data for non-service purposes.

## 16. Customer dashboard

Customer home shows:

- next service;
- active subscriptions;
- service history;
- credits;
- provider messages;
- pause/skip controls;
- cancel controls;
- report an issue;
- leave review after completed service.

Cancellation must be self-service. No "contact support to cancel" dark pattern.

## 17. Messaging

In-app messaging is service-linked.

Rules:

- no public phone/email by default;
- block attempts to send prohibited contact/payment circumvention patterns where practical;
- minors receive stricter content/reporting controls;
- attachments initially limited to service proof images and approved image types;
- customer and provider can report a message;
- admin access is audited;
- retention policy documented and implemented.

## 18. Completion proof

Completion proof is configurable by service.

Examples:

- trash can: one photo of bins at final placement;
- dog walking: completion tap + optional route summary, but never public live tracking;
- yard cleanup: before/after optional;
- watering: completion tap + optional photo.

Exact EXIF geolocation should be stripped from uploaded images before storage/public display.

## 19. Reviews

- Only completed paid occurrences can generate a customer review.
- One review prompt per billing cycle/service, configurable to reduce spam.
- Reviews can be 1-5 stars plus short text.
- Provider can post one public response.
- Abuse/report workflow required.
- No ratings for a provider before a minimum completed-work threshold if the team wants to prevent a single review from defining a minor's public reputation; recommended threshold: 3 completed customer reviews.

## 20. Notifications

Channels:

- email: mandatory transactional baseline;
- SMS: opt-in for time-sensitive reminders;
- push: future PWA/native enhancement.

Key events:

- guardian approval request;
- business approved/published;
- new subscriber;
- upcoming route;
- customer skip/pause;
- provider schedule change;
- completion;
- issue/refund;
- failed payment;
- payout sent;
- review received;
- safety alert.

No marketing SMS without explicit consent.

## 21. Vacation and pause behavior

Provider vacation blocks:

- provider selects unavailable dates;
- system identifies affected occurrences;
- provider chooses approved handling: credit, reschedule within configured window, or customer choice;
- customers are notified before the affected date.

Customer pause:

- pause one occurrence or a date range;
- notice cutoff is service-configurable;
- UI shows whether the occurrence will be credited before confirmation.

## 22. Discovery

V1 discovery is secondary to provider-driven acquisition.

Search can filter by:

- address eligibility;
- category;
- service day;
- recurring frequency;
- price;
- rating;
- available capacity.

Do not show a map of provider home locations. Map results are service coverage zones or generalized business centroids only.

## 23. Trust & Safety

See `SAFETY_TRUST_POLICY.md`. At minimum, implementation must include:

- age gate;
- guardian state machine;
- provider payment/KYC state;
- service allowlist;
- prohibited keyword/manual moderation path;
- public privacy controls;
- address access audit logs;
- report/block tools;
- business kill switch;
- payout holds for fraud/safety review;
- incident case records;
- admin action history.

## 24. Admin console

Required modules:

1. Providers
2. Guardians
3. Customers
4. Businesses/services
5. Service catalog/risk rules
6. Subscriptions/occurrences
7. Payments/payouts/credits
8. Reviews/content reports
9. Safety incidents
10. Fraud/risk flags
11. Feature flags
12. Audit log
13. Analytics

Admin actions require role permissions and reason capture for high-impact actions such as suspensions, address access, refunds above threshold, and guardian override.

## 25. Analytics events

Core funnel:

- provider_signup_started
- age_gate_passed
- guardian_invited
- guardian_verified
- business_draft_created
- service_configured
- payout_onboarding_started
- payout_ready
- business_published
- flyer_generated
- share_link_copied
- service_page_viewed
- address_checked
- address_eligible
- checkout_started
- subscription_started
- occurrence_completed
- occurrence_issue_reported
- subscription_paused
- subscription_canceled
- review_submitted
- referral_converted

## 26. North-star and health metrics

Primary:

**Recurring provider revenue retained after 8 weeks** and **active recurring service relationships**.

Supporting:

- provider publish rate;
- time to first customer;
- first-customer conversion from service page;
- 8-week customer retention;
- occurrence completion rate;
- provider cancellation rate;
- customer issue rate;
- active customers per provider route;
- platform gross margin after payment costs/refunds;
- guardian onboarding completion rate;
- safety incidents per 1,000 occurrences.

Vanity metrics such as raw account count are not launch success criteria.

## 27. Launch definition of done

V1 is ready only when a 13-17 provider with a guardian can publish an approved service, acquire a real customer from a QR/link, complete four weeks of recurring work, receive a payout, handle a skip/credit, receive a review, and have every sensitive action represented correctly in the guardian/admin audit trail.
