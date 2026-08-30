-- 0040  Where the platform may operate.
--
-- Product owner's response of 2026-08-30, item 9:
--
--   "Not Texas-only. Counsel must review material requirements in each U.S.
--    jurisdiction where the platform operates and flag any state that must
--    be restricted until required controls exist."
--
-- This is the lever counsel asked for. Every restriction is a row somebody
-- with authority put here, with a written reason; the rules module in
-- src/domain/jurisdiction.ts only decides what order to read them in.
--
-- ## Server-owned, like the service catalog
--
-- No provider and no customer can write here, for the same reason the
-- service catalog is an allowlist: the whole value of the control is that
-- the people it constrains cannot edit it. Reads are open to everybody,
-- because a customer typing an address needs to be told "not in your state
-- yet" before they get as far as entering a card.
--
-- ## Why the posture is a row and not a constant
--
-- The owner's position is multi-state operation with counsel flagging
-- exceptions, so the default is `open`. But the review has not happened,
-- and a plausible outcome is "we have cleared five states and no others" --
-- which is the `allowlist` posture. Supporting only the posture we expect
-- today would mean rebuilding this the week counsel disagrees, under time
-- pressure, on the path that decides whether a stranger may be sold a
-- service.
--
-- ## Why a reason is NOT NULL
--
-- A restriction nobody wrote a reason for cannot be reviewed, renewed or
-- lifted with confidence. In two years the only way to know whether an
-- entry still applies is what the person who added it wrote down.

create table jurisdiction_rules (
  id           uuid primary key default gen_random_uuid(),

  -- Two-letter US state or territory. Stored uppercase; the domain module
  -- normalises on the way in, and this refuses anything else outright.
  region       char(2) not null check (region ~ '^[A-Z]{2}$'),

  status       text not null check (status in ('allowed', 'blocked')),

  -- NULL means the whole state. A value narrows the rule to one service,
  -- which is the common case: minor-labour rules attach to the kind of
  -- work, not to the marketplace.
  catalog_code text references service_catalog(code) on delete restrict,

  -- Long enough to be a real explanation. A 20-character minimum is the
  -- same bar every audited action in this codebase has to clear.
  reason       text not null check (length(trim(reason)) >= 20),

  -- Who decided, so the entry can be questioned later.
  created_by_user_id uuid references users(id) on delete restrict,
  created_at   timestamptz not null default now(),

  -- Lifting a restriction is an update, not a delete: the row stays so the
  -- history of "when were we closed in Ohio" survives.
  lifted_at    timestamptz,
  lifted_by_user_id uuid references users(id) on delete restrict,
  lift_reason  text,

  constraint lift_has_reason
    check (lifted_at is null or lift_reason is not null)
);

-- One live rule per (state, service). A second contradicting the first
-- would make the answer depend on row order.
create unique index ux_jurisdiction_live
  on jurisdiction_rules (region, coalesce(catalog_code, ''))
  where lifted_at is null;

create index ix_jurisdiction_region on jurisdiction_rules (region) where lifted_at is null;

alter table jurisdiction_rules enable row level security;
alter table jurisdiction_rules force row level security;

-- Readable by anyone, including a signed-out visitor checking an address.
-- Being told "not in your state yet" before entering a card is the point.
revoke all on jurisdiction_rules from anon, authenticated;
grant select on jurisdiction_rules to anon, authenticated;

create policy jurisdiction_read_all on jurisdiction_rules
  for select to anon, authenticated
  using (true);

-- No insert, update or delete policy for anyone. Writes go through the
-- admin console as the service role, which audits them.

comment on table jurisdiction_rules is
  'Server-owned state and per-service restrictions. Populated by counsel through the admin console; never writable by a provider or customer. See src/domain/jurisdiction.ts.';
comment on column jurisdiction_rules.catalog_code is
  'NULL restricts the whole state. A value restricts one service there and leaves the rest available.';

-- ---------------------------------------------------------------------------
-- Platform settings
-- ---------------------------------------------------------------------------
-- One row per named setting. Created here rather than as a bare column so
-- the next piece of configuration that must be changeable without a deploy
-- has somewhere to live -- the platform fee and the retention periods are
-- both candidates, and both are currently constants in code.

create table platform_settings (
  key         text primary key check (length(trim(key)) between 3 and 64),
  value       text not null,
  description text not null,
  updated_at  timestamptz not null default now(),
  updated_by_user_id uuid references users(id) on delete restrict
);

alter table platform_settings enable row level security;
alter table platform_settings force row level security;
revoke all on platform_settings from anon, authenticated;
grant select on platform_settings to anon, authenticated;

create policy platform_settings_read on platform_settings
  for select to anon, authenticated
  using (true);

insert into platform_settings (key, value, description) values (
  'jurisdiction_posture',
  'open',
  'open = operate everywhere except states explicitly blocked (the product owner''s stated position, 2026-08-30). allowlist = operate only in states explicitly cleared, for a staged launch. Changing this changes who can buy.'
);

comment on table platform_settings is
  'Named configuration changeable without a deploy. Read by anyone, written only through the admin console as the service role.';
