-- 0008  Service catalog, businesses, provider services, service areas.
--
-- CLAUDE.md rule 3: the catalog is a server-owned allowlist. Providers never
-- create categories, and provider free text can never widen the scope of an
-- approved service. That is enforced structurally here -- a provider service
-- must reference a catalog row, and no client holds a write grant on the
-- catalog.

-- ---------------------------------------------------------------------------
-- Service catalog
-- ---------------------------------------------------------------------------
create type risk_tier as enum ('A', 'B', 'C', 'X');

create table service_catalog (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,
  name          text not null,
  description   text not null,
  risk_tier     risk_tier not null,
  min_provider_age int not null default 13 check (min_provider_age >= 13),
  -- SAFETY_TRUST_POLICY section 6: Tier B requires a guardian to explicitly
  -- approve the category for a minor, over and above general consent.
  guardian_explicit_approval boolean not null default false,
  -- Feature-flag per market. PRD section 7 notes tutoring may launch
  -- disabled in some markets.
  active        boolean not null default true,
  -- Location rules, equipment restrictions, completion proof, prohibited
  -- add-ons and customer attestations, per SAFETY_TRUST_POLICY section 5.
  configuration jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- Tier C is adult-only by definition; Tier X is prohibited outright and
  -- must never be selectable.
  constraint tier_c_is_adult_only check (risk_tier <> 'C' or min_provider_age >= 18),
  constraint tier_x_is_never_active check (risk_tier <> 'X' or active = false)
);

-- ---------------------------------------------------------------------------
-- Businesses
-- ---------------------------------------------------------------------------
create type business_state as enum (
  'draft','pending','published','paused_guardian','paused_admin','suspended','closed'
);

-- Slugs that must never belong to a provider, because they collide with
-- product routes or look official.
create table reserved_slugs (slug text primary key);
insert into reserved_slugs (slug) values
  ('www'),('api'),('app'),('admin'),('administrator'),('support'),('help'),
  ('about'),('legal'),('terms'),('privacy'),('safety'),('security'),
  ('login'),('logout'),('signin'),('signup'),('register'),('account'),
  ('settings'),('dashboard'),('payouts'),('billing'),('checkout'),
  ('guardian'),('guardians'),('provider'),('providers'),('customer'),
  ('customers'),('search'),('find'),('start'),('explore'),('blog'),
  ('press'),('careers'),('contact'),('status'),('countonlocal'),
  ('stripe'),('webhooks'),('static'),('assets'),('public'),('null'),
  ('undefined'),('me'),('new'),('edit'),('delete');

create table businesses (
  id                uuid primary key default gen_random_uuid(),
  provider_user_id  uuid not null references provider_profiles(user_id) on delete cascade,
  name              text not null check (length(trim(name)) between 2 and 60),
  -- The public URL is countonlocal.com/{slug}.
  slug              text not null unique
                      check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) between 3 and 40),
  tagline           text check (tagline is null or length(tagline) <= 120),
  about             text check (about is null or length(about) <= 2000),
  avatar_asset_id   uuid,
  state             business_state not null default 'draft',
  -- A neighbourhood or city label only. SAFETY_TRUST_POLICY section 3: a
  -- provider's actual location is never public, so this column holds a
  -- coarse label and there is deliberately nowhere to put an address.
  public_area_label text check (public_area_label is null or length(public_area_label) <= 80),
  published_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint published_has_timestamp check (state <> 'published' or published_at is not null)
);

-- Reserved slugs are enforced by trigger: a CHECK constraint cannot contain
-- a subquery, and hardcoding the list into a constraint would mean a
-- migration every time one is added.
create or replace function assert_slug_not_reserved()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.reserved_slugs r where r.slug = new.slug) then
    raise exception 'slug % is reserved', new.slug using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger businesses_slug_not_reserved
  before insert or update of slug on businesses
  for each row
  execute function assert_slug_not_reserved();

create index ix_businesses_provider on businesses (provider_user_id);
create index ix_businesses_published on businesses (slug) where state = 'published';

-- One published business per provider. Drafts may accumulate; a provider
-- cannot run two public storefronts at once in V1.
create unique index ux_one_live_business_per_provider
  on businesses (provider_user_id)
  where state in ('published','pending','paused_guardian','paused_admin');

-- ---------------------------------------------------------------------------
-- Provider services
-- ---------------------------------------------------------------------------
create table provider_services (
  id                 uuid primary key default gen_random_uuid(),
  business_id        uuid not null references businesses(id) on delete cascade,
  catalog_service_id uuid not null references service_catalog(id),
  slug               text not null
                       check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) between 3 and 40),
  public_name        text not null check (length(trim(public_name)) between 2 and 80),
  description        text not null check (length(description) between 10 and 1200),
  -- CLAUDE.md rule 4: integer minor units, never floating point dollars.
  price_cents        int not null check (price_cents > 0 and price_cents <= 100000),
  currency           char(3) not null default 'USD',
  price_unit         text not null check (price_unit in ('week','visit','month')),
  billing_cycle_weeks int not null default 4 check (billing_cycle_weeks in (1,2,4)),
  schedule_rule      jsonb not null,
  capacity_rule      jsonb not null,
  provider_limits    jsonb not null default '{}'::jsonb,
  state              text not null default 'draft' check (state in ('draft','active','paused')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (business_id, slug)
);

create index ix_provider_services_business on provider_services (business_id);

-- ---------------------------------------------------------------------------
-- Service areas
-- ---------------------------------------------------------------------------
-- private_geometry is the real boundary used for address eligibility. It is
-- never exposed to an unauthenticated caller: for a minor provider, a tight
-- polygon around the homes they serve is a strong hint about where they
-- live. public_generalized_geometry is the coarse shape safe to publish.
create table service_areas (
  id                  uuid primary key default gen_random_uuid(),
  provider_service_id uuid not null references provider_services(id) on delete cascade,
  private_geometry    jsonb not null,
  public_generalized_geometry jsonb,
  label               text check (label is null or length(label) <= 80),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (provider_service_id)
);

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table service_catalog   enable row level security;
alter table reserved_slugs    enable row level security;
alter table businesses        enable row level security;
alter table provider_services enable row level security;
alter table service_areas     enable row level security;

-- The catalog is the public menu of what may be offered. Readable, never
-- writable by any client.
create policy catalog_read_active on service_catalog
  for select to anon, authenticated
  using (active = true);

-- A provider sees their own businesses in any state; everyone sees published
-- ones. This is the storefront read path.
create policy businesses_read_own on businesses
  for select to authenticated
  using (provider_user_id = app_current_user_id());

create policy businesses_read_published on businesses
  for select to anon, authenticated
  using (state = 'published');

create policy services_read_own on provider_services
  for select to authenticated
  using (
    exists (
      select 1 from businesses b
      where b.id = business_id and b.provider_user_id = app_current_user_id()
    )
  );

create policy services_read_published on provider_services
  for select to anon, authenticated
  using (
    state = 'active'
    and exists (select 1 from businesses b where b.id = business_id and b.state = 'published')
  );

-- Service areas: the provider only, and only ever through this policy. The
-- public generalized shape is served by the view below, which exposes the
-- coarse column without exposing the row.
create policy service_areas_read_own on service_areas
  for select to authenticated
  using (
    exists (
      select 1 from provider_services ps
      join businesses b on b.id = ps.business_id
      where ps.id = provider_service_id and b.provider_user_id = app_current_user_id()
    )
  );

-- No insert, update or delete policies anywhere above. Every write goes
-- through a server-side service that validates against the catalog and
-- writes an audit row -- a client-side insert on provider_services would let
-- a caller pick their own catalog_service_id and price.
revoke insert, update, delete on service_catalog, businesses, provider_services, service_areas
  from anon, authenticated;
revoke all on reserved_slugs from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Public storefront view
-- ---------------------------------------------------------------------------
-- RLS grants whole rows and the private geometry lives on the same row as
-- the public one, so the coarse shape is exposed through a view that selects
-- only the safe columns.
create view public_service_areas as
  select sa.provider_service_id,
         sa.public_generalized_geometry,
         sa.label
  from service_areas sa
  join provider_services ps on ps.id = sa.provider_service_id
  join businesses b on b.id = ps.business_id
  where b.state = 'published'
    and ps.state = 'active'
    and sa.public_generalized_geometry is not null;

grant select on public_service_areas to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Launch catalog -- PRD section 7, tiers from SAFETY_TRUST_POLICY section 6
-- ---------------------------------------------------------------------------
-- NOTE FOR OWNER REVIEW: exterior_hand_car_wash and
-- ground_level_seasonal_cleanup are not named in the tier examples. Both are
-- solo outdoor manual work with no managed interaction and no prohibited
-- equipment, so both are assigned Tier A here. If either should require
-- explicit guardian approval, move it to B -- that is a one-row update, not
-- a code change.
insert into service_catalog (code, name, description, risk_tier, min_provider_age, guardian_explicit_approval, configuration) values
  ('bin_curb_service', 'Trash and recycling curb service',
   'Move bins between the house and the curb on collection day.',
   'A', 13, false,
   '{"variants":["house_to_curb","curb_to_house","both"],"location":"exterior_only","equipment":[],"completion_proof":"photo"}'),

  ('outdoor_plant_watering', 'Outdoor plant watering',
   'Water outdoor plants, planters and garden beds on a set schedule.',
   'A', 13, false,
   '{"location":"exterior_only","equipment":["hose","watering_can"],"completion_proof":"tap_or_photo"}'),

  ('porch_package_move', 'Porch and package move-in',
   'Move delivered packages from the porch to a safe exterior spot.',
   'A', 13, false,
   '{"location":"porch_only","no_entry":true,"completion_proof":"photo"}'),

  ('manual_yard_cleanup', 'Manual yard cleanup',
   'Raking, hand weeding, and picking up sticks and yard debris. Hand tools only.',
   'A', 13, false,
   '{"location":"exterior_only","equipment":["hand_tools"],"prohibited":["ladders","powered_cutting_tools","pesticides"],"completion_proof":"before_after_optional"}'),

  ('ground_level_seasonal_cleanup', 'Seasonal exterior cleanup',
   'Ground-level seasonal decoration handling and exterior tidying. No ladders.',
   'A', 13, false,
   '{"location":"ground_level_only","prohibited":["ladders","roof_access"],"completion_proof":"photo"}'),

  ('exterior_hand_car_wash', 'Car wash - exterior hand wash',
   'Exterior hand wash of a vehicle on the customer property.',
   'A', 13, false,
   '{"location":"exterior_only","prohibited":["interior_cleaning","engine_bay"],"completion_proof":"photo"}'),

  ('dog_walking', 'Dog walking',
   'Recurring neighbourhood walks, with provider-set limits on dog count and size.',
   'B', 13, true,
   '{"customer_attestations":["dog_count","approx_weight","leash_confirmed","no_bite_history","behaviour_notes","emergency_contact"],"provider_limits":["max_dogs","max_weight"],"completion_proof":"tap_optional_photo","no_live_tracking":true}'),

  ('dog_waste_pickup', 'Dog waste pickup',
   'Yard waste pickup and disposal on a recurring schedule.',
   'B', 13, true,
   '{"location":"exterior_only","customer_attestations":["dogs_secured"],"completion_proof":"photo"}'),

  ('sports_practice', 'Sports and skill practice',
   'Non-contact skill practice in a public or outdoor setting.',
   'B', 13, true,
   '{"location":"public_or_outdoor","non_contact":true,"not_childcare":true,"completion_proof":"tap"}'),

  ('tutoring', 'Tutoring',
   'Remote tutoring, or in an approved public or common-area setting.',
   'B', 13, true,
   '{"location":"remote_or_public","not_childcare":true,"completion_proof":"tap","market_flag":"tutoring_enabled"}');
