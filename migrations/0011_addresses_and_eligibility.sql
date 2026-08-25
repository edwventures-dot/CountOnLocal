-- 0011  Customer addresses, real geometry, and address eligibility.
--
-- TECHNICAL_SPEC section 7 asks for PostGIS where available. It is, so
-- eligibility becomes a real point-in-polygon test in the database rather
-- than a ray-casting loop in application code that would have to be correct
-- about antimeridians and winding order on its own.
--
-- The extension itself is enabled in 0010; see the note there for why it
-- cannot live in this file.

-- ---------------------------------------------------------------------------
-- Service areas gain a real geography column
-- ---------------------------------------------------------------------------
-- GeoJSON stays the input and storage format -- it is what the drawing UI
-- produces and what the API accepts -- and the geography is derived from it,
-- so there is exactly one source of truth and no chance of the two drifting.
alter table service_areas
  add column private_area geography(Geometry, 4326)
    generated always as (st_geomfromgeojson(private_geometry)::geography) stored;

create index ix_service_areas_private_area on service_areas using gist (private_area);

-- ---------------------------------------------------------------------------
-- Customer addresses
-- ---------------------------------------------------------------------------
-- SAFETY_TRUST_POLICY section 3: a customer service address is visible only
-- to that customer, their assigned provider, a linked guardian, and audited
-- staff. It is never in a search result and never public.
create table customer_addresses (
  id             uuid primary key default gen_random_uuid(),
  customer_user_id uuid not null references users(id) on delete cascade,
  -- Stored as entered, for the provider to actually find the house.
  line1          text not null check (length(trim(line1)) between 3 and 120),
  line2          text check (line2 is null or length(line2) <= 80),
  city           text not null check (length(trim(city)) between 1 and 80),
  region         char(2) not null,
  postal_code    text not null check (postal_code ~ '^[0-9]{5}(-[0-9]{4})?$'),
  country_code   char(2) not null default 'US',
  -- What the geocoder returned, kept so a later dispute can distinguish
  -- "we geocoded it wrong" from "they typed it wrong".
  normalized_address text,
  geocoded_at    timestamptz,
  geocoder       text,
  point          geography(Point, 4326),
  -- Gate codes and similar. SAFETY_TRUST_POLICY section 14: restricted
  -- display, never in notification previews, never in analytics.
  access_notes   text check (access_notes is null or length(access_notes) <= 500),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index ix_customer_addresses_customer on customer_addresses (customer_user_id);
create index ix_customer_addresses_point on customer_addresses using gist (point);

-- ---------------------------------------------------------------------------
-- Eligibility
-- ---------------------------------------------------------------------------
-- Answers "is this point inside this service's area" without the caller
-- ever seeing the polygon. That asymmetry is the point: a customer learns
-- yes or no about their own address, and learns nothing about the shape,
-- which for a minor provider is a location hint.
create or replace function address_point_is_eligible(
  p_provider_service_id uuid,
  p_lat double precision,
  p_lng double precision
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  -- Every PostGIS symbol is schema-qualified. search_path is pinned to ''
  -- to defeat hijacking, which also means nothing resolves implicitly --
  -- an unqualified `geography` here fails with "type does not exist".
  select exists (
    select 1
    from public.service_areas sa
    join public.provider_services ps on ps.id = sa.provider_service_id
    join public.businesses b on b.id = ps.business_id
    where sa.provider_service_id = p_provider_service_id
      and ps.state = 'active'
      and b.state = 'published'
      and public.st_covers(
            sa.private_area,
            public.st_setsrid(public.st_makepoint(p_lng, p_lat), 4326)::public.geography
          )
  )
$$;

revoke all on function address_point_is_eligible(uuid, double precision, double precision) from public;
grant execute on function address_point_is_eligible(uuid, double precision, double precision) to authenticated;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table customer_addresses enable row level security;

create policy customer_addresses_read_own on customer_addresses
  for select to authenticated
  using (customer_user_id = app_current_user_id());

-- No client writes: an address is created through a server-side service
-- that geocodes it and records where the coordinates came from.
revoke insert, update, delete on customer_addresses from anon, authenticated;
revoke all on customer_addresses from anon;
