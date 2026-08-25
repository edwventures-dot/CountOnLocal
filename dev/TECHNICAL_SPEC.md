# StreetStart Technical Implementation Specification

## 1. Recommended architecture

Web-first modular monolith for V1. Optimize for shipping, auditability, and a clean domain model rather than premature microservices.

### Frontend
- Next.js + TypeScript.
- Server-rendered public storefronts for SEO/performance.
- Responsive PWA-ready app shell for provider/customer/guardian dashboards.
- Accessible component system using central design tokens.

### Backend
- PostgreSQL.
- API implemented in the web application server and/or serverless functions with strict service boundaries.
- Background-job runner for occurrence generation, billing reconciliation, notifications, payout checks, and scheduled reminders.

### Recommended managed services
- Authentication + PostgreSQL + object storage: Supabase or equivalent managed stack.
- Payments/payouts: Stripe Connect + Stripe Billing/PaymentIntents as appropriate.
- Transactional email: Resend/Postmark equivalent.
- SMS: Twilio equivalent, opt-in only.
- Maps/geocoding/routes: Mapbox or Google Maps Platform.
- Product analytics: PostHog or equivalent with sensitive-data filtering.
- Error monitoring: Sentry or equivalent.

Vendors may change without changing the domain/API design.

## 2. Environments

- local
- development
- staging
- production

Production identity/payment webhooks must never point to non-production endpoints.

Use separate payment processor accounts/keys or modes and separate databases per environment.

## 3. Roles / authorization

Roles are additive permissions, not a single `is_admin` flag.

Suggested roles:

- provider
- guardian
- customer
- support_agent
- trust_safety_agent
- finance_admin
- platform_admin

Authorization must be enforced server-side. Client-side hiding is not authorization.

## 4. Identity and guardian relationships

User has immutable internal UUID.

Provider profile stores private DOB; derived `age_band` can be cached but authoritative age is calculated from DOB and current date.

Guardian relationship is a separate table with state and verification metadata. Never overload `parent_email` on the provider row.

## 5. Public identifiers

Use non-sequential UUIDs/ULIDs for internal entities and slugs for public businesses.

Do not expose auto-incrementing IDs for sensitive records.

## 6. Service catalog

Catalog data is server-owned and versioned.

Provider service references a catalog service and stores only allowed overrides:

- title suffix/marketing name;
- approved description;
- selected variants;
- price;
- frequency;
- schedule;
- capacity;
- service area;
- provider-specific limits.

Risk policy is evaluated at publish and checkout time.

## 7. Geospatial model

Use PostGIS if available.

Store:

- normalized service address;
- encrypted/restricted raw address fields as required;
- geocoded point;
- provider service-area polygon/multipolygon;
- public generalized geography separately.

Address eligibility is a server-side point-in-polygon operation.

Never deliver all service-area geometries for minor providers to an unauthenticated client if it creates privacy risk.

## 8. Scheduling model

A recurring `subscription` is the commercial relationship.

A `service_occurrence` is an operational instance.

Generate occurrences in a rolling horizon (recommended 8-12 weeks) and extend daily. Do not generate years of rows up front.

A schedule definition should support:

- weekly;
- every 2 weeks;
- every 4 weeks;
- selected weekdays;
- service window;
- blackout/vacation dates;
- start/end dates where applicable.

Use IANA time zones and store timestamps in UTC. Service date should also be stored as local-date semantics to avoid DST mistakes.

## 9. Billing architecture

Recommended V1 approach:

- StreetStart is marketplace platform.
- Provider has a Stripe connected account.
- Customer stores payment method with Stripe.
- StreetStart computes each 4-week billing cycle from planned billable occurrences.
- Charge includes provider service subtotal + platform fee.
- Provider ledger receives the service subtotal.
- Credits reduce future cycle subtotal or produce refund when needed.

Exact Connect charge type (destination charge vs separate charges/transfers) is an implementation/legal/accounting decision, but domain records must remain processor-agnostic.

Do not make Stripe objects the source of truth for service scheduling.

## 10. Internal money ledger

Maintain an append-only ledger for:

- customer charge;
- platform fee;
- provider earning;
- credit;
- refund;
- dispute;
- payout;
- adjustment.

Store amounts as integer minor currency units (cents), not floating point.

Every ledger row references source entity and external processor ID when applicable.

## 11. Payment idempotency

All payment-changing operations require idempotency keys.

Webhook handlers:

- verify signatures;
- persist raw event metadata safely;
- de-duplicate by external event ID;
- process asynchronously when practical;
- support replay;
- never assume event order.

## 12. Notification outbox

Business transaction writes a notification/outbox record. Worker sends email/SMS. This prevents lost notifications when an HTTP request succeeds but external messaging fails.

No sensitive address/access code in notification previews.

## 13. Route planning

Route planning inputs:

- service occurrence coordinates;
- provider private start/end preference;
- service duration estimate;
- service windows;
- provider travel mode.

Outputs:

- ordered occurrence IDs;
- estimated distance/time;
- route revision timestamp.

Do not persist third-party turn-by-turn data longer than vendor terms/need require.

## 14. File uploads

Allowed initial types: JPEG, PNG, HEIC converted server-side if supported.

Pipeline:

1. signed upload URL;
2. content-type and magic-byte validation;
3. malware/image safety checks if vendor available;
4. metadata/EXIF strip;
5. resize derivatives;
6. private storage;
7. authorization on every fetch.

## 15. Audit log

Record immutable events for:

- guardian approval/revocation;
- provider/service publish state;
- address access by admin;
- payout holds/releases;
- refunds/credits above configured threshold;
- incident actions;
- account suspension;
- risk rule changes;
- admin role/permission changes.

Fields:

`actor_user_id`, `actor_role`, `action`, `target_type`, `target_id`, `before_json`, `after_json`, `reason_code`, `ip_hash`, `created_at`.

Sensitive fields are redacted from before/after snapshots.

## 16. Security baseline

- TLS everywhere.
- Secure, HTTP-only cookies or equivalent secure token storage.
- CSRF protection where relevant.
- Rate limiting on auth, address checking, checkout, messaging, report endpoints.
- Row-level authorization for provider/customer/guardian data.
- Separate privileged service credentials from public frontend keys.
- Secret management via environment secret store.
- Database backups and restore test.
- Dependency scanning.
- CSP and standard security headers.
- Sanitized user-generated HTML; V1 should store plain text/structured content rather than arbitrary HTML.

## 17. Privacy logging rules

Never send to analytics:

- full customer address;
- DOB;
- guardian SSN/identity data;
- gate/access code;
- private message body;
- uploaded photo raw URL;
- payment method details.

Use stable opaque IDs and coarse geography where analytics needs segmentation.

## 18. Caching / SEO

Public storefronts can be cached/revalidated when published business/service data changes.

Private eligibility and capacity checks are never static-cached by address.

Structured data can describe LocalBusiness/Service carefully, but do not publish a minor provider's home address as schema.org location.

## 19. Feature flags

Required flags:

- market enablement;
- service category enablement;
- age/category rules;
- customer discovery;
- reviews;
- SMS;
- referral rewards;
- public indexing;
- background-check integration;
- adult-only categories.

## 20. Core background jobs

- extend occurrence horizon;
- send tomorrow/today reminders;
- process 4-week billing cycles;
- retry failed payments;
- apply credits;
- payout availability/reconciliation;
- service capacity recalculation;
- guardian state expiration checks;
- review request scheduling;
- stale draft cleanup/anonymization;
- data retention tasks;
- analytics rollups.

## 21. Observability

Dashboards/alerts:

- checkout failures;
- webhook lag/failure;
- occurrence generator failures;
- payment mismatch;
- payout exceptions;
- email/SMS failure;
- elevated incident reports;
- auth abuse/rate-limit spikes;
- address/geocoder failures.

Every customer-facing error receives a trace/correlation ID hidden behind a support-details expander.

## 22. Performance targets

- Public storefront LCP target <= 2.5s at p75 on mobile where practical.
- Address eligibility response target <= 2s excluding geocoder cold edge cases.
- Dashboard initial useful content <= 2.5s p75.
- Route page can progressively load map after stop list.

## 23. Data retention

Create configurable retention policy by entity class. Safety/financial records may need longer retention than ordinary drafts/messages. Do not invent indefinite retention by default.

User deletion must honor legal/financial retention while removing/de-identifying data that no longer needs to be tied to the user.

## 24. Implementation principle

If there is a conflict between convenience and privacy for a minor provider, V1 defaults to privacy and requires an explicit product review to loosen it.
