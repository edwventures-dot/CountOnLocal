-- 0013  Subscriptions, service occurrences, and the money ledger.
--
-- TECHNICAL_SPEC section 9: "Do not make Stripe objects the source of truth
-- for service scheduling." So the commercial relationship and the operational
-- instances both live here, and Stripe holds a payment method and processes
-- charges we compute -- not a Stripe Subscription that decides when work
-- happens.

-- ---------------------------------------------------------------------------
-- Subscriptions
-- ---------------------------------------------------------------------------
create table subscriptions (
  id                   uuid primary key default gen_random_uuid(),
  customer_user_id     uuid not null references users(id) on delete restrict,
  provider_service_id  uuid not null references provider_services(id) on delete restrict,
  service_address_id   uuid not null references customer_addresses(id) on delete restrict,
  state                subscription_state not null default 'pending',

  -- Priced at signup and held. A provider raising their price must not
  -- silently reprice existing customers; PRD section 12 sells reliability,
  -- and a bill that changes without warning is the opposite of that.
  provider_price_cents int not null check (provider_price_cents > 0),
  price_unit           text not null check (price_unit in ('week','visit','month')),
  platform_fee_bps     int not null check (platform_fee_bps between 0 and 10000),
  platform_fee_min_cents int not null check (platform_fee_min_cents >= 0),
  billing_cycle_weeks  int not null default 4 check (billing_cycle_weeks in (1,2,4)),

  current_cycle_start  date,
  current_cycle_end    date,
  next_charge_at       timestamptz,

  stripe_customer_id       text,
  stripe_payment_method_id text,

  -- Scoped to the service. SAFETY_TRUST_POLICY section 14: an access code
  -- lives here as restricted data, never in a notification preview or an
  -- analytics payload.
  customer_instructions text check (customer_instructions is null or length(customer_instructions) <= 500),

  started_at   timestamptz,
  canceled_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint active_needs_payment_method
    check (state <> 'active' or stripe_payment_method_id is not null),
  constraint canceled_has_timestamp
    check (state <> 'canceled' or canceled_at is not null)
);

create index ix_subscriptions_customer on subscriptions (customer_user_id, state);
create index ix_subscriptions_service on subscriptions (provider_service_id, state);
create index ix_subscriptions_due on subscriptions (next_charge_at) where state = 'active';

-- One live subscription per customer per service per address. A second
-- checkout for the same house and service is a mistake, not a second order.
create unique index ux_one_live_subscription
  on subscriptions (customer_user_id, provider_service_id, service_address_id)
  where state in ('pending','active','paused','payment_failed');

-- ---------------------------------------------------------------------------
-- Service occurrences
-- ---------------------------------------------------------------------------
-- TECHNICAL_SPEC section 8: generated on a rolling horizon, never years
-- ahead. Dates are local calendar dates alongside an IANA zone, so a DST
-- change cannot move a Tuesday route to Monday.
create table service_occurrences (
  id              uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references subscriptions(id) on delete cascade,
  service_date    date not null,
  local_timezone  text not null,
  service_window_start time,
  service_window_end   time,
  state           occurrence_state not null default 'scheduled',
  route_order     int,
  -- The value of this one occurrence, held at generation time for the same
  -- reason the subscription holds its price.
  service_value_cents int not null check (service_value_cents >= 0),
  completion_note text,
  completed_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (subscription_id, service_date),
  constraint completed_has_timestamp
    check (state not in ('completed','settled') or completed_at is not null)
);

create index ix_occurrences_subscription on service_occurrences (subscription_id, service_date);
create index ix_occurrences_route on service_occurrences (service_date, state);

-- ---------------------------------------------------------------------------
-- Ledger
-- ---------------------------------------------------------------------------
-- CLAUDE.md rule 4: every money movement lands here, in integer cents, with
-- its source entity and processor id. Append-only: no update or delete
-- grant is issued to anyone, including the application.
create table ledger_entries (
  id            uuid primary key default gen_random_uuid(),
  kind          ledger_kind not null,
  -- bigint because cents accumulate. Signed: a credit or refund is negative
  -- from the platform's perspective, so a sum over a subscription is
  -- meaningful without a per-kind sign lookup.
  amount_cents  bigint not null,
  currency      char(3) not null default 'USD',
  customer_user_id uuid references users(id),
  provider_user_id uuid references users(id),
  subscription_id  uuid references subscriptions(id),
  occurrence_id    uuid references service_occurrences(id),
  external_processor text,
  external_id        text,
  -- Set for anything that moved money at a processor, so a replayed webhook
  -- cannot double-post.
  idempotency_key text unique,
  memo          text,
  created_at    timestamptz not null default now()
);

create index ix_ledger_subscription on ledger_entries (subscription_id, created_at);
create index ix_ledger_provider on ledger_entries (provider_user_id, created_at);
create index ix_ledger_external on ledger_entries (external_processor, external_id);

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table subscriptions       enable row level security;
alter table service_occurrences enable row level security;
alter table ledger_entries      enable row level security;
alter table ledger_entries      force row level security;

-- A customer sees their own subscriptions. The assigned provider sees them
-- too, because they have to actually do the work -- SAFETY_TRUST_POLICY
-- section 3 lists the assigned provider among those who may see a service
-- address.
create policy subscriptions_read_customer on subscriptions
  for select to authenticated
  using (customer_user_id = app_current_user_id());

create policy subscriptions_read_provider on subscriptions
  for select to authenticated
  using (
    exists (
      select 1 from provider_services ps
      join businesses b on b.id = ps.business_id
      where ps.id = provider_service_id and b.provider_user_id = app_current_user_id()
    )
  );

create policy occurrences_read_party on service_occurrences
  for select to authenticated
  using (
    exists (
      select 1 from subscriptions s
      left join provider_services ps on ps.id = s.provider_service_id
      left join businesses b on b.id = ps.business_id
      where s.id = subscription_id
        and (s.customer_user_id = app_current_user_id()
             or b.provider_user_id = app_current_user_id())
    )
  );

-- The ledger has no client read policy at all. A provider sees their
-- earnings through a Money view built for that purpose, not by querying the
-- ledger directly, so the raw rows stay server-side.

revoke insert, update, delete on subscriptions, service_occurrences from anon, authenticated;
revoke all on ledger_entries from anon, authenticated;
revoke all on subscriptions, service_occurrences from anon;
