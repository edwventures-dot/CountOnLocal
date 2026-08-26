-- 0015  Pre-launch waitlist.
--
-- The coming-soon landing page collects interest before the product opens.
-- This table holds it, and it is intentionally the thinnest table in the
-- schema.
--
-- What is NOT here matters more than what is. No date of birth, no name, no
-- street address, no phone, no school. SAFETY_TRUST_POLICY section 17 is
-- data minimisation, and a waitlist grants nothing -- there is no service to
-- authorise, no payment to take and no age to gate, so there is nothing an
-- identity field would be for. The 13+ provider rule is stated on the page
-- and enforced at real signup, where a DOB genuinely is needed.
--
-- postal_code is the one field that earns its place. Launch geography is
-- chosen by route density (GO_TO_MARKET), so knowing that forty people in
-- one ZIP want this is the difference between a viable first market and a
-- scattered one. Five digits is the coarse geography TECHNICAL_SPEC section
-- 17 explicitly permits; it cannot be resolved to a household.

create table waitlist_signups (
  id           uuid primary key default gen_random_uuid(),

  -- Stored already lowercased and trimmed by src/domain/waitlist.ts. The
  -- constraint is a backstop against a future caller that forgets.
  email        text not null check (email = lower(email) and length(email) between 3 and 254),

  -- A check constraint rather than an enum, unlike 0012. Enums are worth
  -- their ceremony for states a machine transitions through; this is a
  -- fixed list of three audiences that will not gain members without a
  -- product decision, and a check keeps it in one file.
  role         text not null check (role in ('provider','customer','guardian')),

  -- Five digits, or null. Never ZIP+4: the extra four narrow a ZIP to
  -- roughly a city block, which is closer to an address than we want.
  postal_code  text check (postal_code is null or postal_code ~ '^[0-9]{5}$'),

  created_at   timestamptz not null default now(),

  -- One row per person per audience. Signing up twice as a provider is a
  -- no-op; signing up as both a provider and a customer is a real thing a
  -- parent-of-a-provider might do, so it is allowed.
  unique (email, role)
);

-- Density queries: "which ZIPs have enough interest to launch in".
create index ix_waitlist_postal on waitlist_signups (postal_code) where postal_code is not null;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
-- Enabled with NO policies at all, which means: deny everything to anon and
-- to signed-in users alike. Reads and writes both.
--
-- That is deliberate and it is stricter than it may look necessary. The
-- obvious alternative -- an anon INSERT policy so the browser can write
-- directly -- would also mean anyone holding the anon key (which ships in
-- the browser bundle by design) could enumerate nothing but could still
-- stuff the table freely. Worse, a later policy edit that grants SELECT by
-- accident would expose an email list.
--
-- Instead the only writer is POST /v1/waitlist, which uses the service role
-- and validates first. One door, and the database refuses everything else.
alter table waitlist_signups enable row level security;

comment on table waitlist_signups is
  'Pre-launch interest. No RLS policies by design: the service role via POST /v1/waitlist is the only writer, and nothing may read it through PostgREST.';
