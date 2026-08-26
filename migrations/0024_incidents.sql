-- 0024  Safety incidents.
--
-- SAFETY_TRUST_POLICY section 15: capture reporter, business, subscription,
-- occurrence, category, narrative and timestamps; preserve relevant audit
-- records; allow immediate pause; restrict payout where policy permits;
-- notify a guardian when a minor is involved and it is safe to; document
-- every admin action; and no public disclosure of private details.
--
-- ## Everything is ON DELETE RESTRICT
--
-- An incident is the record of something that happened to somebody. If
-- deleting a subscription would cascade an incident away, then the way to
-- erase a safety report is to cancel a subscription -- which is exactly the
-- move somebody would make. So the deletes fail loudly instead, and
-- TECHNICAL_SPEC section 23's note that safety records may need longer
-- retention than ordinary ones is why that is the right way round.
--
-- ## No client access at all
--
-- Not a narrow policy: none. An incident narrative contains a reporter's
-- account of something that may involve a child, and PRD section 24 puts
-- these behind staff roles which this schema does not model as database
-- roles. Access is through server paths that check permissions and write an
-- audit row -- the same arrangement the audit log itself uses.

create type incident_state as enum ('open', 'investigating', 'resolved', 'closed');
create type incident_severity as enum ('S0', 'S1', 'S2', 'S3');

create table incidents (
  id            uuid primary key default gen_random_uuid(),

  severity      incident_severity not null,
  state         incident_state not null default 'open',
  category      text not null check (length(category) between 3 and 64),

  -- Who reported it. Nullable: an incident can be opened by staff from a
  -- phone call, and the caller may not have an account.
  reporter_user_id uuid references users(id) on delete restrict,

  -- What it is about. All optional -- a report may name a business without
  -- a specific visit, or a visit without knowing the subscription.
  business_id      uuid references businesses(id) on delete restrict,
  subscription_id  uuid references subscriptions(id) on delete restrict,
  occurrence_id    uuid references service_occurrences(id) on delete restrict,
  provider_user_id uuid references users(id) on delete restrict,

  -- The reporter's account, in their words.
  narrative     text not null check (length(narrative) between 10 and 5000),

  -- Set when a minor is party to it, so the queue can sort on it without a
  -- join and a guardian notification decision has what it needs.
  involves_minor boolean not null default false,

  -- When somebody must have looked, from RESPONSE_TARGET_MINUTES.
  respond_by    timestamptz not null,
  first_viewed_at timestamptz,

  resolution    text,
  resolved_at   timestamptz,
  resolved_by_user_id uuid references users(id) on delete restrict,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint resolved_has_detail
    check (state not in ('resolved','closed') or (resolution is not null and resolved_at is not null))
);

-- The queue: unresolved, most urgent and most overdue first.
create index ix_incidents_queue
  on incidents (severity, respond_by)
  where state in ('open', 'investigating');

create index ix_incidents_business on incidents (business_id, created_at desc);
create index ix_incidents_provider on incidents (provider_user_id, created_at desc);
create index ix_incidents_minor on incidents (involves_minor, created_at desc) where involves_minor;

-- ---------------------------------------------------------------------------
-- Payout holds
-- ---------------------------------------------------------------------------
-- SAFETY_TRUST_POLICY 15: "restrict payout where policy permits". A hold is
-- its own row rather than a flag on the provider, so the reason, the person
-- who placed it and the person who lifted it all survive -- a boolean would
-- record only the current answer.

create table payout_holds (
  id            uuid primary key default gen_random_uuid(),
  provider_user_id uuid not null references users(id) on delete restrict,
  incident_id   uuid references incidents(id) on delete restrict,
  reason        text not null check (length(reason) >= 20),
  placed_by_user_id uuid not null references users(id) on delete restrict,
  placed_at     timestamptz not null default now(),
  released_at   timestamptz,
  released_by_user_id uuid references users(id) on delete restrict,
  release_reason text,

  constraint release_has_detail
    check (released_at is null or (released_by_user_id is not null and release_reason is not null))
);

-- One live hold per provider. Stacking holds would make "is this provider
-- paid" a question with several answers.
create unique index ux_one_live_payout_hold
  on payout_holds (provider_user_id)
  where released_at is null;

alter table incidents enable row level security;
alter table payout_holds enable row level security;
alter table incidents force row level security;
alter table payout_holds force row level security;
revoke all on incidents from anon, authenticated;
revoke all on payout_holds from anon, authenticated;

comment on table incidents is
  'SAFETY_TRUST_POLICY 15. No client access: reached only through server paths that check a staff permission and write an audit row. Deletes RESTRICT so a safety report cannot be erased by cancelling a subscription.';
comment on table payout_holds is
  'A row rather than a flag, so the reason and both actors survive a release.';
