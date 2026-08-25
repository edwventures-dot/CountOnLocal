-- 0006  Readiness follows Stripe's capability status, not the requirements list.
--
-- 0005 required stripe_requirements_due to be empty before a provider counted
-- as payout ready. That is wrong in a way that would have looked like a bug
-- with no error message: Stripe keeps a capability `active` while
-- future-dated requirements are still outstanding, so a perfectly functional
-- account can carry entries. Blocking on them would have stranded providers
-- who had done everything asked of them.
--
-- The capability status IS Stripe's answer to "can money move". It flips to
-- restricted when requirements actually block it. The requirements list is
-- for telling a guardian what to go and do, not for gating.

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
         and hp.is_adult
      from public.provider_profiles pp
      join public.users h on h.id = pp.payout_account_user_id
      left join lateral (
        select coalesce(
          (select ph.date_of_birth <= (current_date - interval '18 years')
             from public.provider_profiles ph where ph.user_id = h.id),
          true
        ) as is_adult
      ) hp on true
      where pp.user_id = p_provider_user_id
    ),
    false
  )
$$;

comment on column users.stripe_requirements_due is
  'Stripe v2 requirement entries awaiting action FROM THE USER. Informational: drives what the guardian is asked to complete. Does not gate readiness -- capability status does.';
