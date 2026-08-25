# Count On Local V1 QA / Acceptance Criteria

## Release gate philosophy

The V1 acceptance suite must prove the recurring business lifecycle, not merely that screens load.

## 1. Golden-path end-to-end test

A 16-year-old provider must be able to:

1. register and pass the age gate;
2. invite a guardian;
3. save a business draft before guardian verification;
4. complete guardian verification;
5. configure an approved low-risk service;
6. complete payout onboarding;
7. publish a public page;
8. generate a QR/share link;
9. have an adult customer enter an eligible address;
10. start a recurring subscription;
11. receive a scheduled occurrence;
12. see the stop on the Today dashboard;
13. complete the occurrence;
14. generate the proper earning/ledger entries;
15. repeat through a 4-week billing cycle;
16. have the customer skip one eligible occurrence and see correct credit behavior;
17. receive/leave an eligible review;
18. receive provider payout state;
19. have the guardian see the correct operational history;
20. have admin audit logs for all high-impact actions.

Failure at any step is launch-blocking.

## 2. Under-13 gate

- DOB yielding age 12 is blocked.
- User cannot bypass by direct API call.
- No business/provider row becomes publishable.
- Error is neutral and does not encourage entering a false DOB.

## 3. Guardian tests

- Minor cannot publish while guardian state is incomplete.
- Verified guardian allows publish if all other requirements pass.
- Revocation immediately prevents new checkout.
- Revocation stops future automatic charges according to policy.
- Guardian can pause business.
- Provider cannot remove required guardian client-side or via API.
- Public page never exposes guardian identity.

## 4. Service risk tests

- Provider cannot select disabled catalog service.
- Minimum-age rules enforced server-side.
- Description containing prohibited work can be flagged/rejected.
- Provider cannot alter catalog risk tier through API.
- Customer instructions cannot transform approved job into prohibited work without triggering report/moderation path.

## 5. Address/privacy tests

- Public API does not return provider home address.
- Public API does not return customer addresses.
- Ineligible address check does not reveal exact service-area boundary.
- Provider can access only addresses tied to active/authorized occurrences.
- Guardian can access only addresses for linked provider operations.
- Admin address access is role-controlled and audited.
- Analytics payload contains no full address/DOB/gate code.

## 6. Money tests

### Example weekly $3 service

- list price: $3/week;
- cycle subtotal: $12.00 for 4 billable occurrences;
- 15% platform fee: $1.80;
- customer total: $13.80 before applicable tax;
- provider earning: $12.00;
- ledger balances exactly.

Test:

- provider skip -> proportional credit;
- customer timely skip -> configured credit/skip behavior;
- late skip -> disclosure follows policy;
- failed payment -> occurrence/customer state follows policy;
- refund -> provider/platform ledger adjusts correctly;
- duplicate webhook -> no duplicate money;
- webhook delivered out of order -> final state correct;
- two checkout submissions with same idempotency key -> one subscription/charge.

## 7. Scheduling tests

- weekly recurrence across DST boundary;
- every-2-week recurrence;
- 4-week recurrence;
- vacation block;
- service day change;
- customer pause spanning cycle boundary;
- cancellation before future occurrence generation;
- provider timezone vs customer browser timezone;
- occurrence date remains correct when UTC date differs.

## 8. Capacity tests

- checkout blocked when route capacity reached.
- concurrent last-slot checkout cannot oversell beyond configured policy.
- canceled subscription releases future capacity.
- pause behavior follows configured capacity reservation policy.

## 9. Route tests

- only due/eligible occurrences included;
- route order persisted/versioned;
- no cross-provider stops;
- address remains masked outside authorized route view where designed;
- route calculation failure leaves usable stop list.

## 10. Messaging tests

- only authorized customer/provider relationship can open conversation.
- blocked user cannot send.
- report creates moderation record.
- HTML/script content rendered safely as text.
- rate limits work.
- gate/access code is not copied to analytics/logs.

## 11. Review tests

- no review before qualifying completed paid service.
- customer cannot review unrelated provider.
- provider response limited to own review.
- report/moderation changes public visibility as designed.
- rating aggregation handles hidden/removed reviews correctly.

## 12. Upload tests

- reject executable/invalid image masquerading as JPEG.
- strip EXIF location.
- private image URL cannot be accessed by unrelated user.
- oversized image handled safely.
- deleted/retained according to policy.

## 13. Accessibility checks

- keyboard-only completion of provider onboarding and customer checkout.
- focus order logical.
- all inputs labeled.
- error summary receives focus when validation fails.
- contrast meets AA.
- mobile touch targets >= 44px for primary actions.
- 200% zoom no content loss.
- map has non-map service-area alternative.

## 14. Responsive matrix

Minimum manual/browser testing:

- 360px mobile;
- 390/393px modern phone;
- 768px tablet;
- 1024px small desktop/tablet landscape;
- 1440px desktop.

Browsers: current Chrome, Safari, Firefox, Edge. Mobile Safari and Chrome are launch-required.

## 15. Security checks

- authorization tests for every role/entity boundary;
- CSRF where applicable;
- secure session/cookie flags;
- passwordless/OAuth callback protection if used;
- rate limits;
- dependency/vulnerability scan;
- CSP/security headers;
- webhook signature verification;
- secret scanning;
- no PII in error traces.

## 16. Admin tests

- support agent cannot use finance/trust-safety powers without role.
- suspension requires reason.
- payout hold/release audited.
- manual address access audited.
- risk-rule change audited.
- incident case retains action history.

## 17. Launch SLO checks

Before release, staging load smoke test should verify public page, eligibility, checkout preview, provider Today, and admin incident queue under expected pilot load with headroom.

## 18. Final launch blockers

Any of these blocks public launch:

- minor can publish without required guardian state;
- private address leak;
- duplicate charge/payout bug;
- self-service cancellation broken;
- prohibited service bypass;
- admin authorization bypass;
- missing payment webhook idempotency;
- route date shifts due to timezone/DST;
- public claim implies verification/background check not actually performed.
