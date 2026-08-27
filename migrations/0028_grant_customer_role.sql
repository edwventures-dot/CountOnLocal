-- 0028  Every account is a customer.
--
-- `subscription:create` belongs to the `customer` role and nothing anywhere
-- granted that role. providerOnboarding grants `provider`;
-- acceptGuardianInvitation grants `guardian`; no code path granted
-- `customer`. So no account could subscribe to anything, and the entire
-- customer side was unreachable -- the permission existed, the guard
-- existed, and the grant between them did not.
--
-- Same shape as the provider_services draft/active gap: a column and a gate
-- shipped, the step between them did not, and integration tests inserted
-- the end state directly so nothing noticed.
--
-- ## Why at provisioning rather than at first purchase
--
-- Being a customer is not a privileged state. It is what a signed-in person
-- is by default -- roles here are additive permissions, and `provider` and
-- `guardian` are the ones that have to be earned. The sign-up page already
-- promises "one account works for both sides", and this is what makes that
-- sentence true.
--
-- Granting it lazily at checkout would mean the guard on the very request
-- that needs it has to grant it first, which is a guard that cannot refuse.
--
-- ## What this does NOT do
--
-- It does not decide whether the holder may actually buy. PRD section 6
-- keeps that on the 18+ attestation at checkout, which is unchanged. This
-- grant says "you are an ordinary account", not "you are an adult".

create or replace function handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  domain_user_id uuid;
begin
  insert into public.users (auth_user_id, email, phone_e164, email_verified_at)
  values (new.id, new.email, new.phone, new.email_confirmed_at)
  on conflict (auth_user_id) do nothing
  returning id into domain_user_id;

  -- ON CONFLICT DO NOTHING returns no row, so a re-fired trigger on an
  -- existing account has to look the id up rather than skipping the grant.
  if domain_user_id is null then
    select id into domain_user_id from public.users where auth_user_id = new.id;
  end if;

  if domain_user_id is not null then
    insert into public.user_roles (user_id, role)
    values (domain_user_id, 'customer')
    on conflict (user_id, role) do nothing;
  end if;

  return new;
end;
$$;

-- Everyone who signed up before this existed.
insert into public.user_roles (user_id, role)
select u.id, 'customer'
from public.users u
left join public.user_roles r on r.user_id = u.id and r.role = 'customer'
where r.user_id is null
on conflict (user_id, role) do nothing;

comment on function handle_new_auth_user is
  'Creates the domain user row and grants the customer role. Customer is the default state of any account; provider and guardian are additive and earned.';
