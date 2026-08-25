-- Count On Local V1 reference schema (PostgreSQL / PostGIS-oriented)
-- Names and columns are implementation guidance, not migration-ready without engineering review.

create extension if not exists pgcrypto;
-- create extension if not exists postgis;

create type user_role as enum ('provider','guardian','customer','support_agent','trust_safety_agent','finance_admin','platform_admin');
create type guardian_state as enum ('not_required','required_uninvited','invited','guardian_started','verified','revoked','expired','manual_review');
create type business_state as enum ('draft','pending','published','paused_guardian','paused_admin','suspended','closed');
create type subscription_state as enum ('pending','active','paused','payment_failed','canceled','ended');
create type occurrence_state as enum ('scheduled','due_today','started','completed','settled','provider_skipped','customer_skipped','issue_reported','credited','canceled');
create type ledger_kind as enum ('customer_charge','platform_fee','provider_earning','credit','refund','dispute','payout','adjustment');

create table users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  phone_e164 text unique,
  email_verified_at timestamptz,
  phone_verified_at timestamptz,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table user_roles (
  user_id uuid not null references users(id) on delete cascade,
  role user_role not null,
  primary key (user_id, role)
);

create table provider_profiles (
  user_id uuid primary key references users(id) on delete cascade,
  date_of_birth date not null,
  country_code char(2) not null default 'US',
  display_first_name text not null,
  guardian_state guardian_state not null,
  stripe_connected_account_id text,
  payout_ready boolean not null default false,
  private_home_address_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table guardian_profiles (
  user_id uuid primary key references users(id) on delete cascade,
  stripe_person_or_rep_id text,
  identity_state text not null default 'unverified',
  created_at timestamptz not null default now()
);

create table guardian_relationships (
  id uuid primary key default gen_random_uuid(),
  provider_user_id uuid not null references provider_profiles(user_id) on delete cascade,
  guardian_user_id uuid references guardian_profiles(user_id) on delete set null,
  invitation_email text,
  invitation_phone text,
  state guardian_state not null,
  consented_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table businesses (
  id uuid primary key default gen_random_uuid(),
  provider_user_id uuid not null references provider_profiles(user_id) on delete cascade,
  name text not null,
  slug text not null unique,
  tagline text,
  about text,
  avatar_asset_id uuid,
  state business_state not null default 'draft',
  public_area_label text,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table service_catalog (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  description text not null,
  risk_tier text not null,
  min_provider_age int not null default 13,
  guardian_explicit_approval boolean not null default false,
  active boolean not null default true,
  configuration jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table provider_services (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  catalog_service_id uuid not null references service_catalog(id),
  slug text not null,
  public_name text not null,
  description text not null,
  price_cents int not null check (price_cents >= 0),
  currency char(3) not null default 'USD',
  price_unit text not null, -- e.g. week / visit
  billing_cycle_weeks int not null default 4,
  schedule_rule jsonb not null,
  capacity_rule jsonb not null,
  provider_limits jsonb not null default '{}'::jsonb,
  state text not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, slug)
);

create table service_areas (
  id uuid primary key default gen_random_uuid(),
  provider_service_id uuid not null references provider_services(id) on delete cascade,
  private_geometry jsonb not null, -- replace with PostGIS geometry in implementation
  public_generalized_geometry jsonb,
  label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table addresses (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid references users(id) on delete set null,
  encrypted_address jsonb not null,
  normalized_city text,
  normalized_state text,
  normalized_postal_code text,
  latitude numeric(10,7),
  longitude numeric(10,7),
  geocoder_provider text,
  geocoder_place_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table provider_profiles
  add constraint fk_provider_home_address
  foreign key (private_home_address_id) references addresses(id) on delete set null;

create table subscriptions (
  id uuid primary key default gen_random_uuid(),
  customer_user_id uuid not null references users(id),
  provider_service_id uuid not null references provider_services(id),
  service_address_id uuid not null references addresses(id),
  state subscription_state not null default 'pending',
  provider_price_cents int not null,
  platform_fee_bps int not null,
  platform_fee_min_cents int not null,
  billing_cycle_weeks int not null default 4,
  current_cycle_start date,
  current_cycle_end date,
  next_charge_at timestamptz,
  stripe_customer_id text,
  stripe_payment_method_id text,
  customer_instructions text,
  started_at timestamptz,
  canceled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table service_occurrences (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references subscriptions(id) on delete cascade,
  service_date date not null,
  local_timezone text not null,
  service_window_start time,
  service_window_end time,
  state occurrence_state not null default 'scheduled',
  route_order int,
  service_value_cents int not null,
  completion_note text,
  completed_at timestamptz,
  issue_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (subscription_id, service_date)
);

create table assets (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid references users(id),
  storage_key text not null unique,
  purpose text not null,
  content_type text not null,
  bytes bigint,
  exif_stripped boolean not null default false,
  private boolean not null default true,
  created_at timestamptz not null default now()
);

create table occurrence_proofs (
  id uuid primary key default gen_random_uuid(),
  occurrence_id uuid not null references service_occurrences(id) on delete cascade,
  asset_id uuid not null references assets(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table ledger_entries (
  id uuid primary key default gen_random_uuid(),
  kind ledger_kind not null,
  amount_cents bigint not null,
  currency char(3) not null default 'USD',
  customer_user_id uuid references users(id),
  provider_user_id uuid references users(id),
  subscription_id uuid references subscriptions(id),
  occurrence_id uuid references service_occurrences(id),
  external_processor text,
  external_id text,
  source_type text not null,
  source_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table conversations (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid references subscriptions(id) on delete set null,
  provider_user_id uuid not null references users(id),
  customer_user_id uuid not null references users(id),
  created_at timestamptz not null default now()
);

create table messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  sender_user_id uuid not null references users(id),
  body text not null,
  moderation_state text not null default 'normal',
  created_at timestamptz not null default now()
);

create table reviews (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references subscriptions(id),
  customer_user_id uuid not null references users(id),
  business_id uuid not null references businesses(id),
  rating int not null check (rating between 1 and 5),
  body text,
  provider_response text,
  moderation_state text not null default 'published',
  created_at timestamptz not null default now()
);

create table incidents (
  id uuid primary key default gen_random_uuid(),
  severity text not null,
  reporter_user_id uuid references users(id),
  reported_user_id uuid references users(id),
  business_id uuid references businesses(id),
  subscription_id uuid references subscriptions(id),
  occurrence_id uuid references service_occurrences(id),
  category text not null,
  narrative text not null,
  status text not null default 'open',
  assigned_user_id uuid references users(id),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  channel text not null,
  template_key text not null,
  payload jsonb not null,
  state text not null default 'queued',
  scheduled_at timestamptz not null default now(),
  sent_at timestamptz,
  provider_message_id text,
  created_at timestamptz not null default now()
);

create table audit_log (
  id bigserial primary key,
  actor_user_id uuid references users(id),
  actor_role text,
  action text not null,
  target_type text not null,
  target_id text not null,
  before_json jsonb,
  after_json jsonb,
  reason_code text,
  ip_hash text,
  created_at timestamptz not null default now()
);

create index ix_businesses_provider on businesses(provider_user_id);
create index ix_provider_services_business on provider_services(business_id);
create index ix_subscriptions_customer on subscriptions(customer_user_id, state);
create index ix_subscriptions_service on subscriptions(provider_service_id, state);
create index ix_occurrences_date on service_occurrences(service_date, state);
create index ix_occurrences_subscription on service_occurrences(subscription_id);
create index ix_ledger_provider on ledger_entries(provider_user_id, created_at desc);
create index ix_incidents_status on incidents(status, severity, created_at);
create index ix_notifications_queue on notifications(state, scheduled_at);
