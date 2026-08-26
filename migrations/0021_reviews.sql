-- 0021  Reviews.
--
-- PRD section 19. Every rule in that section is either a constraint here or
-- a check in domain/review.ts, and the two most important ones are:
--
--   - a review hangs off a completed occurrence, so there is always a
--     visit behind it and no way to review a service never received;
--   - a provider has no public rating until enough reviews exist, because
--     a public score on this platform attaches to a named fourteen-year-old
--     and one annoyed neighbour would otherwise define it permanently.
--
-- The threshold is enforced in the domain rather than in SQL, because it is
-- a display rule: the reviews below it exist, the provider can read them,
-- and the storefront simply shows no number.

create type review_state as enum (
  'published',   -- visible, subject to the display threshold
  'hidden',      -- auto-hidden on report, awaiting a human
  'removed'      -- taken down by trust and safety
);

create table reviews (
  id            uuid primary key default gen_random_uuid(),

  -- The visit being reviewed. RESTRICT rather than CASCADE: a review is
  -- evidence, and deleting an occurrence should fail loudly rather than
  -- quietly taking the review with it.
  occurrence_id uuid not null unique references service_occurrences(id) on delete restrict,
  subscription_id uuid not null references subscriptions(id) on delete restrict,

  -- Denormalised so the storefront can aggregate without walking three
  -- joins on a page that must render fast.
  provider_service_id uuid not null references provider_services(id) on delete restrict,
  provider_user_id    uuid not null references users(id) on delete restrict,
  customer_user_id    uuid not null references users(id) on delete restrict,

  rating        int not null check (rating between 1 and 5),
  body          text check (body is null or length(body) <= 1000),

  -- PRD section 19: one public response, and only one.
  response_body text check (response_body is null or length(response_body) <= 1000),
  responded_at  timestamptz,

  state         review_state not null default 'published',

  -- The billing cycle this review counts against, for the one-per-cycle
  -- rule. Stored rather than derived so a later cycle-window change cannot
  -- retroactively let somebody review twice.
  cycle_start   date,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint response_has_timestamp
    check (response_body is null or responded_at is not null)
);

-- One review per customer per service per cycle. The domain checks this
-- first with a friendlier message; this is what makes it true under a
-- double-tapped submit button.
create unique index ux_one_review_per_cycle
  on reviews (customer_user_id, provider_service_id, cycle_start)
  where cycle_start is not null;

create index ix_reviews_service on reviews (provider_service_id, created_at desc);
create index ix_reviews_provider on reviews (provider_user_id, state);
create index ix_reviews_customer on reviews (customer_user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Reports
-- ---------------------------------------------------------------------------

create table review_reports (
  id            uuid primary key default gen_random_uuid(),
  review_id     uuid not null references reviews(id) on delete cascade,
  reporter_user_id uuid not null references users(id) on delete cascade,
  reason        text not null check (length(reason) between 3 and 64),
  detail        text check (detail is null or length(detail) <= 1000),
  resolved_at   timestamptz,
  resolution    text,
  created_at    timestamptz not null default now(),

  -- One report per person per review. A provider cannot bury a review by
  -- filing the same complaint six times.
  unique (review_id, reporter_user_id)
);

create index ix_review_reports_open on review_reports (created_at) where resolved_at is null;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table reviews enable row level security;
alter table review_reports enable row level security;
revoke all on reviews from anon, authenticated;
revoke all on review_reports from anon, authenticated;

-- Published reviews are public: they are the social proof on a storefront,
-- and a storefront is read by an unauthenticated neighbour with a flyer.
--
-- Only the columns a stranger should see. customer_user_id is deliberately
-- readable so a client can tell "this is mine" -- it is an opaque id, not a
-- name, and the storefront never joins it to anything.
grant select (
  id, occurrence_id, provider_service_id, provider_user_id, customer_user_id,
  rating, body, response_body, responded_at, state, created_at
) on reviews to anon, authenticated;

create policy reviews_read_published on reviews
  for select to anon, authenticated
  using (state = 'published');

-- A provider sees their own reviews whatever state they are in, including
-- hidden ones. Being told a review exists and is under review is better
-- than it silently vanishing from their dashboard.
create policy reviews_read_provider on reviews
  for select to authenticated
  using (provider_user_id = app_current_user_id());

-- And a customer sees their own, for the same reason from the other side.
create policy reviews_read_customer on reviews
  for select to authenticated
  using (customer_user_id = app_current_user_id());

-- No client writes to either table. Writing a review requires checking that
-- the occurrence was delivered, that it belongs to this customer, and that
-- the cycle has not already been reviewed -- none of which a policy can do
-- as well as the service can, and all of which must be audited.

comment on table reviews is
  'PRD 19. One per completed occurrence, one per cycle per service, one provider response. Public rating is withheld below a threshold -- see domain/review.ts.';
comment on table review_reports is
  'Moderation queue. Some reasons hide the review immediately; see AUTO_HIDE_REASONS.';
