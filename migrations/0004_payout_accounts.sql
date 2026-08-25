-- 0004  Payout accounts.
--
-- Stripe requires a connected account holder to be an adult. For a 13-17
-- provider that is their guardian; for an 18+ provider it is themselves.
--
-- 0001 put stripe_connected_account_id on provider_profiles, which assumes
-- the provider holds the account -- false for every minor, who are the
-- majority of the launch audience. The account therefore moves to the user
-- who legally holds it, and the provider points at that user.
--
-- The result is one code path for both shapes rather than a special case
-- for minors, which is the kind of branch that eventually forgets to check
-- whether a payout is going somewhere legal.

-- ---------------------------------------------------------------------------
-- The account lives with its holder.
-- ---------------------------------------------------------------------------
alter table users
  add column stripe_connected_account_id text unique,
  -- Mirrored from Stripe rather than assumed. Stripe is the source of truth
  -- for whether an account can actually transact; these columns are a cache
  -- refreshed by webhook and by explicit sync.
  add column stripe_charges_enabled  boolean not null default false,
  add column stripe_payouts_enabled  boolean not null default false,
  add column stripe_requirements_due jsonb  not null default '[]'::jsonb,
  add column stripe_synced_at        timestamptz;

create index ix_users_connected_account on users (stripe_connected_account_id);

-- ---------------------------------------------------------------------------
-- The provider points at the holder.
-- ---------------------------------------------------------------------------
alter table provider_profiles
  add column payout_account_user_id uuid references users(id) on delete restrict;

create index ix_provider_payout_account on provider_profiles (payout_account_user_id);

-- Nothing has onboarded yet, so there is no data to migrate.
alter table provider_profiles drop column stripe_connected_account_id;

-- payout_ready was a stored boolean that could drift from what Stripe
-- actually permits. Dropped in favour of deriving it, so there is exactly
-- one answer to "can this provider be paid" and it is the true one.
alter table provider_profiles drop column payout_ready;

-- ---------------------------------------------------------------------------
-- Derived payout readiness.
-- ---------------------------------------------------------------------------
-- A provider can be paid when they have a payout account, that account
-- belongs to an adult, and Stripe says it can both charge and pay out.
--
-- The adult check is repeated here rather than trusted from application
-- code: it is the constraint that keeps money from being routed to a
-- minor's own account, and it should hold even if a future code path
-- forgets.
create or replace function provider_payout_ready(p_provider_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select h.stripe_charges_enabled
         and h.stripe_payouts_enabled
         and h.stripe_connected_account_id is not null
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

revoke all on function provider_payout_ready(uuid) from public;
grant execute on function provider_payout_ready(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Guard: a minor may never be their own payout account holder.
-- ---------------------------------------------------------------------------
-- Enforced as a trigger rather than a CHECK because it spans two rows.
create or replace function assert_payout_holder_is_adult()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  holder_dob date;
begin
  if new.payout_account_user_id is null then
    return new;
  end if;

  select pp.date_of_birth into holder_dob
  from public.provider_profiles pp
  where pp.user_id = new.payout_account_user_id;

  -- No provider profile means the holder is a guardian or staff account,
  -- which carries no date of birth here and is adult by Stripe's own
  -- onboarding requirements.
  if holder_dob is not null and holder_dob > (current_date - interval '18 years') then
    raise exception 'payout account holder must be an adult'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger provider_payout_holder_adult
  before insert or update of payout_account_user_id on provider_profiles
  for each row
  execute function assert_payout_holder_is_adult();

-- Clients never write Stripe state; it is mirrored server-side from Stripe.
revoke insert, update, delete on users from anon, authenticated;
