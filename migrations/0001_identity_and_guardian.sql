-- 0001  Identity, roles, and the guardian relationship.
--
-- Covers build-sequence step 1. Derived from dev/DATA_MODEL.sql, with the
-- constraints that reference schema left to "engineering review" made
-- explicit here.
--
-- The application layer in src/domain already enforces these rules. They are
-- repeated as database constraints on purpose: QA_ACCEPTANCE section 2
-- requires that the under-13 gate cannot be bypassed "by direct API call",
-- and a constraint holds even when a future endpoint forgets to call the
-- gate.

create extension if not exists pgcrypto;

create type user_role as enum (
  'provider','guardian','customer',
  'support_agent','trust_safety_agent','finance_admin','platform_admin'
);

create type guardian_state as enum (
  'not_required','required_uninvited','invited','guardian_started',
  'verified','revoked','expired','manual_review'
);

create table users (
  id                uuid primary key default gen_random_uuid(),
  email             text unique,
  phone_e164        text unique,
  email_verified_at timestamptz,
  phone_verified_at timestamptz,
  status            text not null default 'active'
                      check (status in ('active','suspended','closed')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- An account with no way to reach it cannot be verified or notified.
  constraint users_need_a_contact check (email is not null or phone_e164 is not null)
);

-- Additive permissions. There is deliberately no is_admin column here;
-- TECHNICAL_SPEC section 3 requires roles to compose.
create table user_roles (
  user_id uuid not null references users(id) on delete cascade,
  role    user_role not null,
  granted_at      timestamptz not null default now(),
  granted_by      uuid references users(id),
  primary key (user_id, role)
);

create table provider_profiles (
  user_id             uuid primary key references users(id) on delete cascade,
  -- Private. Never exposed publicly, never sent to analytics
  -- (SAFETY_TRUST_POLICY sections 1 and 17). Age is always recomputed from
  -- this column; no cached age or is_minor flag exists to be tampered with.
  date_of_birth       date not null check (date_of_birth <= current_date),
  country_code        char(2) not null default 'US',
  display_first_name  text not null check (length(trim(display_first_name)) > 0),
  guardian_state      guardian_state not null,
  stripe_connected_account_id text,
  payout_ready        boolean not null default false,
  private_home_address_id uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- The under-13 gate, enforced in the schema. PRD section 6.
  constraint provider_min_age_13
    check (date_of_birth <= (current_date - interval '13 years')),

  -- A provider under 18 can never sit at not_required. This is the exact
  -- tampering case gates.ts detects; the database refuses to store it.
  constraint minor_requires_guardian_state
    check (
      date_of_birth <= (current_date - interval '18 years')
      or guardian_state <> 'not_required'
    )
);

create table guardian_profiles (
  user_id        uuid primary key references users(id) on delete cascade,
  stripe_person_or_rep_id text,
  identity_state text not null default 'unverified'
                   check (identity_state in ('unverified','pending','verified','failed')),
  created_at     timestamptz not null default now()
);

create table guardian_relationships (
  id                uuid primary key default gen_random_uuid(),
  provider_user_id  uuid not null references provider_profiles(user_id) on delete cascade,
  guardian_user_id  uuid references guardian_profiles(user_id) on delete set null,
  invitation_email  text,
  invitation_phone  text,
  state             guardian_state not null,
  consented_at      timestamptz,
  revoked_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- A verified relationship must record who consented and when; otherwise
  -- "Guardian connected" would be a trust claim with nothing behind it
  -- (SAFETY_TRUST_POLICY section 19).
  constraint verified_requires_consent
    check (state <> 'verified' or (guardian_user_id is not null and consented_at is not null)),
  constraint revoked_requires_timestamp
    check (state <> 'revoked' or revoked_at is not null),
  constraint invitation_needs_a_destination
    check (state = 'not_required' or invitation_email is not null or invitation_phone is not null)
);

-- At most one live relationship per provider. Historical revoked and expired
-- rows are kept for the audit trail rather than deleted.
create unique index ux_guardian_active_per_provider
  on guardian_relationships (provider_user_id)
  where state not in ('revoked','expired');

create index ix_guardian_rel_provider on guardian_relationships (provider_user_id);
create index ix_guardian_rel_guardian on guardian_relationships (guardian_user_id);

-- CLAUDE.md rule 9. Append-only: no update or delete grants are issued.
create table audit_log (
  id            bigserial primary key,
  actor_user_id uuid references users(id),
  actor_role    text,
  action        text not null,
  target_type   text not null,
  target_id     text not null,
  before_json   jsonb,
  after_json    jsonb,
  reason_code   text,
  ip_hash       text,
  created_at    timestamptz not null default now()
);

create index ix_audit_target on audit_log (target_type, target_id, created_at desc);
create index ix_audit_actor  on audit_log (actor_user_id, created_at desc);
