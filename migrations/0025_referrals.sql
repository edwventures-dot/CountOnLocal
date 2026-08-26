-- 0025  Referrals: the reward 0022 deliberately did not build.
--
-- UX_UI_SPEC section 13's V1 recommendation is a first-cycle platform-fee
-- discount for the customer and a fee-sponsored bonus for the provider
-- after a qualifying paid occurrence. Both are money, so both get a row
-- with a state, not a boolean on a subscription.
--
-- ## Terms are frozen at signup
--
-- customer_discount_bps and provider_bonus_cents are stored per referral
-- rather than read from configuration at payout time. Same discipline as
-- subscriptions.platform_fee_bps: a promotion that gets less generous next
-- month must not retroactively shrink a reward somebody was already
-- promised, and a promotion that gets more generous must not silently
-- backdate itself onto referrals that were made under the old terms.
--
-- ## Why the referring provider is denormalised
--
-- referral_codes.provider_user_id is the live owner of a code, and a code
-- can be revoked and -- in principle -- the row deleted with its provider.
-- Who earned this particular referral is a fact about the past. Copying it
-- here means revoking a code stops new referrals without disturbing the
-- ones already owed.

create table referrals (
  id            uuid primary key default gen_random_uuid(),

  -- One referral per subscription. A customer cannot stack codes, and a
  -- retry of checkout cannot create a second claim on the same signup.
  subscription_id uuid not null unique references subscriptions(id) on delete restrict,

  code          text not null references referral_codes(code) on delete restrict,
  provider_user_id uuid not null references users(id) on delete restrict,
  customer_user_id uuid not null references users(id) on delete restrict,

  state         text not null default 'pending'
                check (state in ('pending', 'qualified', 'paid', 'void')),

  -- Frozen at signup. See the header.
  customer_discount_bps integer not null check (customer_discount_bps between 0 and 10000),
  provider_bonus_cents  integer not null check (provider_bonus_cents >= 0),

  -- What the discount actually came to, once a cycle was priced. NULL until
  -- the first charge; non-NULL is the marker that says the discount has
  -- been spent, so a second settlement cannot spend it again.
  discount_applied_cents integer check (discount_applied_cents >= 0),
  discount_applied_at    timestamptz,

  qualified_at  timestamptz,
  paid_at       timestamptz,
  voided_at     timestamptz,
  void_reason   text,

  created_at    timestamptz not null default now(),

  -- A provider cannot refer themselves a customer. The platform would be
  -- paying a bonus for a signup it would have got anyway, and the cost
  -- lands on the platform fee, which is real money.
  constraint referral_is_not_self
    check (provider_user_id <> customer_user_id),

  -- The two timestamps that mean money moved cannot be set without the
  -- state that explains them.
  constraint paid_requires_state
    check (paid_at is null or state = 'paid'),
  constraint qualified_before_paid
    check (paid_at is null or qualified_at is not null),
  constraint void_has_reason
    check (voided_at is null or void_reason is not null),
  constraint discount_amount_has_timestamp
    check ((discount_applied_cents is null) = (discount_applied_at is null))
);

-- The daily reward job scans for work by state.
create index ix_referrals_state on referrals (state) where state in ('pending', 'qualified');
create index ix_referrals_provider on referrals (provider_user_id);

alter table referrals enable row level security;
alter table referrals force row level security;
revoke all on referrals from anon, authenticated;

-- A provider sees the referrals they earned, and nothing about who the
-- customer is. Reading the customer_user_id of a stranger who used your
-- code would turn a referral code into a way to learn that a specific
-- account signed up -- and on this platform the reader is often a minor and
-- the subject is often their neighbour.
grant select (id, code, provider_user_id, state, provider_bonus_cents, qualified_at, paid_at, created_at)
  on referrals to authenticated;

create policy referrals_read_own_provider on referrals
  for select to authenticated
  using (provider_user_id = app_current_user_id());

comment on table referrals is
  'UX_UI_SPEC 13. Terms frozen at signup so changing the promotion cannot reprice a reward already promised. discount_applied_cents is the idempotency marker for the first-cycle discount; the bonus uses a ledger idempotency key instead.';
comment on column referrals.discount_applied_cents is
  'NULL until the first charge applies the discount. Non-NULL means spent -- checked before a settlement discounts anything, so a re-run cannot discount twice.';
comment on column referrals.provider_user_id is
  'Denormalised from referral_codes on purpose: who earned this referral is a fact about the past, and revoking a code must not disturb rewards already owed.';
