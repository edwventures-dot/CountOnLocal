# StreetStart Safety & Trust Policy - Product Rules

## Purpose

StreetStart enables local service relationships that may involve minors. Safety rules are product requirements, not optional content guidelines.

This file defines the V1 behavior the application must enforce. Legal counsel should convert these product rules into final Terms/Privacy/Safety language before public launch.

## 1. Age and account rules

- Under 13: no account creation or service provision.
- Ages 13-17: guardian relationship required before publication/payment acceptance.
- 18+: guardian not required.
- Customers: 18+ in V1.
- Date of birth is private and never public.
- Guardian legal/identity data is private and never public.

## 2. Guardian state machine

`not_required`  
`required_uninvited`  
`invited`  
`guardian_started`  
`verified`  
`revoked`  
`expired`  
`manual_review`

A minor provider may save drafts while guardian state is incomplete but cannot publish a paid service.

If guardian approval is revoked:

1. business enters `paused_guardian`;
2. no new customers can subscribe;
3. future charges stop;
4. already-paid pending service occurrences are surfaced to support/guardian for safe resolution;
5. provider is not publicly told sensitive guardian details beyond `Guardian approval is required to continue.`

## 3. Address privacy

### Provider home/start location
Never public. Never rendered as a public map pin. Stored encrypted/controlled where required for route calculation.

### Customer service address
Visible only to:

- that customer;
- assigned provider when operationally necessary;
- linked guardian for a minor provider;
- authorized StreetStart staff with audited access.

Search/indexing endpoints must not return raw customer addresses.

### Public area
Show neighborhood/city/ZIP-derived general labels or generalized polygons only. Apply minimum-density rules before displaying social proof tied to geography.

## 4. Live location

V1 does not expose a minor's live location to customers or the public.

Route optimization may occur on-device/server-side using planned stops. If future GPS features are added, they require a separate privacy/safety design review.

## 5. Service catalog governance

Every service has:

- risk tier;
- minimum provider age;
- guardian permission requirement;
- location rules;
- equipment restrictions;
- configurable completion proof;
- prohibited add-ons;
- customer attestations where applicable.

Provider free-text cannot override the catalog. Example: a provider cannot turn `manual yard cleanup` into `chainsaw tree trimming` through a description.

## 6. Recommended V1 risk tiers

### Tier A - low risk
Examples: trash-can curb service, outdoor watering, package move-in, manual leaf/stick pickup.

Minimum age: 13.

### Tier B - managed interaction
Examples: dog walking, dog waste pickup, tutoring, sports practice.

Minimum age and constraints configurable. Guardian must explicitly approve for minors.

### Tier C - adult-only future categories
Any category allowed only for 18+ after separate review.

### Tier X - prohibited
Licensed/hazardous/in-home/high-trust categories listed in PRD.

## 7. Animal safety

For dog walking:

Customer must provide:

- dog count;
- approximate weight/size;
- leash/harness confirmation;
- aggression/bite-history attestation;
- behavior notes;
- emergency contact.

Provider sets personal limits. The system must not match an animal outside those limits.

StreetStart may suspend a dog/service after a safety report.

## 8. Equipment rules

Minor providers cannot advertise or be instructed through StreetStart to use prohibited equipment. Service instructions are scanned/reviewed for obvious attempts to bypass this.

V1 minor-safe defaults:

- hand tools: generally allowed when service catalog permits;
- ladders: prohibited;
- chainsaws/powered cutting tools: prohibited;
- heavy machinery: prohibited;
- pesticides/regulated chemicals: prohibited;
- customer-supplied hazardous tools: prohibited.

## 9. Communication safety

- Messaging is tied to a service/business relationship.
- Block/report actions are always available.
- Do not show a minor provider's direct email/phone by default.
- Automated systems may detect attempted off-platform payment/contact exchange, threats, sexual content, or prohibited work offers for review.
- Safety reports receive higher priority than ordinary support tickets.

## 10. Customer identity / conduct

V1 should require:

- verified email;
- verified mobile number before first paid service;
- valid payment method;
- service-address verification sufficient for payment/risk systems;
- acceptance of Customer Conduct rules.

For higher-risk categories/markets, StreetStart can require additional identity verification through feature flags.

## 11. Provider identity

Use payment processor KYC/KYB requirements as the minimum financial identity layer, not as the sole safety claim.

Public copy should say exactly what was verified. Do not imply a criminal background check unless one was actually performed.

## 12. Background checks

Background checks are not a blanket V1 promise. If EDW Ventures chooses to add them, the UI must identify:

- who was checked;
- what type of check;
- when;
- whether the badge expires;
- limitations required by vendor/legal guidance.

Never market "background checked" based only on payment identity verification.

## 13. Completion photos

- Strip EXIF metadata before persistent storage.
- Keep private by default.
- Public portfolio use requires separate customer consent and provider/guardian eligibility.
- Faces, license plates, house numbers, keys, access codes, and private documents should not be encouraged in photos.

## 14. Access codes / keys

V1 discourages keys and interior access. If a service requires a gate code, store it as sensitive service instruction data with restricted display and no analytics logging.

Never include gate/access codes in email subject lines, push previews, logs, or analytics payloads.

## 15. Incident workflow

Severity:

- S0: immediate threat / emergency report
- S1: physical safety, harassment, credible threat, missing animal, serious property issue
- S2: repeated boundary violation, unsafe instruction, significant payment/fraud issue
- S3: ordinary quality/service dispute

System behavior:

- capture reporter, business, subscription, occurrence, category, narrative, attachments, timestamps;
- preserve relevant audit records;
- allow immediate account/business pause;
- restrict payout where policy permits;
- notify guardian when a minor provider is involved and safe/legal to do so;
- document every admin action;
- no public disclosure of private incident details.

## 16. Emergency language

StreetStart is not an emergency service. In an active emergency, UI should direct the user to local emergency services without pretending StreetStart can dispatch help.

## 17. Data minimization

Do not collect:

- school name;
- class schedule;
- unnecessary exact age display;
- provider social accounts by default;
- guardian data beyond operational/legal/payment need;
- live GPS history in V1.

## 18. Search engine / metadata rules

Provider public pages may be indexable after provider/guardian opt-in and only contain public business data.

Minor privacy defaults:

- no DOB;
- no last name unless explicitly required/approved (default first name or business name only);
- no home address;
- no school;
- no customer address;
- no exact schedule beyond service availability window.

## 19. Trust copy that is allowed

Allowed when factual:

- `Guardian connected`
- `Identity verified`
- `Payments handled securely`
- `12 completed services`
- `Serving this area`

Avoid without documented basis:

- `Safe provider`
- `Fully vetted`
- `Background checked`
- `StreetStart guarantees your safety`

## 20. Regulatory/product review triggers

A new review is mandatory before adding:

- under-13 users;
- childcare;
- in-home services by minors;
- live location;
- background checks;
- transportation;
- medication/eldercare;
- employer-like shift assignment;
- provider insurance claims;
- school partnerships involving student data;
- international launch.
