-- 0022  Referral codes.
--
-- UX_UI_SPEC section 13: a provider-specific code, shared on a flyer and
-- read aloud across a fence. The alphabet in domain/density.ts excludes
-- 0/O and 1/I/L for that reason -- a code nobody can transcribe is worse
-- than no code.
--
-- The reward itself is not built here. UX_UI_SPEC's V1 recommendation is a
-- first-cycle platform-fee discount for the customer and a fee-sponsored
-- bonus for the provider after a qualifying paid occurrence, and both are
-- money movements that belong with the ledger work rather than being
-- half-implemented alongside a code generator.

create table referral_codes (
  code          text primary key check (length(code) = 8),
  provider_user_id uuid not null references users(id) on delete cascade,
  -- One live code per provider. Rotating one means revoking the old, not
  -- accumulating several that all work.
  revoked_at    timestamptz,
  created_at    timestamptz not null default now()
);

create unique index ux_one_live_referral_code
  on referral_codes (provider_user_id)
  where revoked_at is null;

alter table referral_codes enable row level security;
revoke all on referral_codes from anon, authenticated;

-- A provider reads their own. Nobody enumerates the table: a code is a
-- credential of sorts, and a list of them would let anyone attribute
-- signups to a provider who never shared one.
grant select (code, provider_user_id, revoked_at, created_at) on referral_codes to authenticated;

create policy referral_codes_read_own on referral_codes
  for select to authenticated
  using (provider_user_id = app_current_user_id());

comment on table referral_codes is
  'Provider referral codes. One live per provider; rotation revokes rather than accumulates.';
