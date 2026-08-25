-- 0005  Align payout columns with Stripe Accounts v2.
--
-- 0004 was written against Accounts v1, which reports charges_enabled and
-- payouts_enabled as booleans. Stripe now requires v2 for new Connect
-- integrations, and v2 models capabilities as statuses instead:
--
--   configuration.recipient.capabilities.stripe_balance.stripe_transfers.status
--   configuration.recipient.capabilities.stripe_balance.payouts.status
--
-- charges_enabled has no meaning for us at all. Under the Marketplace model
-- the platform is merchant of record and charges the customer directly; the
-- connected account never processes a card. What matters is whether we can
-- transfer money to the account, and whether the account can pay out to a
-- bank. Renaming rather than keeping v1 vocabulary that would quietly
-- mislead whoever reads this next.
--
-- Nothing is deployed and no account rows exist, so this is a plain rename.

alter table users rename column stripe_charges_enabled to stripe_transfers_active;
alter table users rename column stripe_payouts_enabled to stripe_payouts_active;

comment on column users.stripe_transfers_active is
  'Stripe v2 stripe_balance.stripe_transfers.status = active. Can we send money to this account.';
comment on column users.stripe_payouts_active is
  'Stripe v2 stripe_balance.payouts.status = active. Can this account pay out to a bank.';
comment on column users.stripe_requirements_due is
  'Stripe v2 requirements.entries still awaiting action. Empty means nothing outstanding.';

-- Rebuild the readiness function against the renamed columns. Same rule:
-- a provider can be paid when they have an account, it belongs to an adult,
-- and Stripe says money can both arrive and leave.
create or replace function provider_payout_ready(p_provider_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select h.stripe_transfers_active
         and h.stripe_payouts_active
         and h.stripe_connected_account_id is not null
         and jsonb_array_length(h.stripe_requirements_due) = 0
         and hp.is_adult
      from public.provider_profiles pp
      join public.users h on h.id = pp.payout_account_user_id
      left join lateral (
        select coalesce(
          (select ph.date_of_birth <= (current_date - interval '18 years')
             from public.provider_profiles ph where ph.user_id = h.id),
          true  -- a holder with no provider profile is an adult guardian
        ) as is_adult
      ) hp on true
      where pp.user_id = p_provider_user_id
    ),
    false
  )
$$;
