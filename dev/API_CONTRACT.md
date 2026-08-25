# Count On Local API Contract - V1 Surface

This is a behavioral contract, not a requirement to use REST. GraphQL/RPC is acceptable if equivalent authorization, idempotency, validation, and audit behavior exist.

## Conventions

- JSON over HTTPS.
- Authenticated endpoints derive user identity from server-verified session/token.
- Mutation requests accept `Idempotency-Key` where money or durable workflow transitions occur.
- IDs are UUID/ULID-like opaque strings.
- Monetary values are integer cents with currency code.
- Error shape:

```json
{
  "error": {
    "code": "SERVICE_AREA_NOT_ELIGIBLE",
    "message": "This address is outside the current service area.",
    "requestId": "req_...",
    "fieldErrors": {}
  }
}
```

## Auth / onboarding

### `POST /v1/provider/onboarding/start`
Creates provider profile and age state.

Input: DOB, country, contact verification state.

Output: next onboarding stage and whether guardian is required.

### `POST /v1/guardian/invitations`
Provider creates guardian invitation.

### `POST /v1/guardian/invitations/{token}/accept`
Guardian accepts relationship and begins verification/payment representative workflow.

### `POST /v1/guardian/relationships/{id}/revoke`
Revokes consent and triggers business pause policy.

## Business / service

### `POST /v1/businesses`
Create draft business.

### `PATCH /v1/businesses/{id}`
Allowed public branding fields only.

### `POST /v1/businesses/{id}/services`
Create service from catalog.

### `PATCH /v1/provider-services/{id}`
Price, schedule, limits, capacity, approved description.

### `PUT /v1/provider-services/{id}/service-area`
Store polygon/radius representation after server validation.

### `POST /v1/businesses/{id}/publish`
Runs publication policy. Returns validation failures as structured rules.

## Public storefront

### `GET /v1/public/businesses/{slug}`
Returns public-safe data only.

### `GET /v1/public/businesses/{slug}/services/{serviceSlug}`
Public service detail.

### `POST /v1/public/provider-services/{id}/eligibility`
Input customer address. Server geocodes/checks coverage and capacity.

Response does not return provider private service-area geometry.

## Checkout / subscription

### `POST /v1/checkout/preview`
Calculates provider subtotal, platform fee, billing cycle, tax if any, start date, and eligibility.

### `POST /v1/subscriptions`
Creates subscription and initial processor setup/charge flow.

Idempotent.

### `POST /v1/subscriptions/{id}/skip`
Skips specified occurrence/date range under notice policy.

### `POST /v1/subscriptions/{id}/pause`
Pause range.

### `POST /v1/subscriptions/{id}/cancel`
Self-service cancellation with effective date and financial summary.

## Occurrences

### `GET /v1/provider/today`
Returns provider-authorized stops, ordered route summary, alerts.

For minor provider, this endpoint requires valid guardian state.

### `POST /v1/occurrences/{id}/complete`
Completion state + optional proof upload reference.

### `POST /v1/occurrences/{id}/provider-skip`
Applies provider-skip policy and credit.

### `POST /v1/occurrences/{id}/report-issue`
Provider or customer report depending actor permissions.

## Money

### `GET /v1/provider/money/summary`
Provider earning/pending/paid totals.

### `GET /v1/provider/ledger`
Paginated provider-visible ledger.

### `GET /v1/customer/billing`
Customer charges, credits, refunds, invoices/receipts.

## Messaging

### `GET /v1/conversations`
Actor-scoped.

### `POST /v1/conversations/{id}/messages`
Plain-text message. Server moderation/rate limits apply.

### `POST /v1/messages/{id}/report`
Safety/content report.

## Reviews

### `POST /v1/reviews`
Requires eligible completed paid relationship.

### `POST /v1/reviews/{id}/response`
Provider response.

### `POST /v1/reviews/{id}/report`
Moderation queue.

## Growth

### `POST /v1/provider/flyers/preview`
Returns render payload or generated asset.

### `POST /v1/provider/share-links`
Create campaign/referral link.

### `GET /v1/provider/density`
Returns privacy-safe route density insights.

## Guardian

### `GET /v1/guardian/providers/{providerId}/overview`
Guardian-linked operational view.

### `PATCH /v1/guardian/providers/{providerId}/permissions`
Category/feature permissions.

### `POST /v1/guardian/providers/{providerId}/pause`
Immediate provider business pause.

## Admin

Admin endpoints are separate namespace and require explicit roles.

Examples:

- `GET /v1/admin/incidents`
- `POST /v1/admin/incidents/{id}/actions`
- `POST /v1/admin/businesses/{id}/suspend`
- `POST /v1/admin/payouts/{id}/hold`
- `POST /v1/admin/refunds`
- `PATCH /v1/admin/service-catalog/{id}`

## Payment webhooks

Handlers required for relevant Stripe events, including connected account requirements, charge/payment success/failure, refunds, disputes, and payout state.

Rules:

1. verify webhook signature;
2. de-duplicate external event ID;
3. persist processing state;
4. do not expose raw event body to ordinary application logs;
5. map processor state to internal ledger/workflow;
6. support replay from admin/developer tools.

## Notification webhook/callbacks

Email/SMS delivery callbacks update notification status but must not alter core business state.
