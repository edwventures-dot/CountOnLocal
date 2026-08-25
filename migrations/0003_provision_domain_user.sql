-- 0003  Provision a domain user whenever an auth user is created.
--
-- 0002 split identity in two: auth.users is the credential, public.users is
-- the domain record every foreign key points at. Nothing was creating the
-- second one, so the first authenticated request from a new account failed
-- on provider_profiles_user_id_fkey. Found by the HTTP layer test.
--
-- Doing this as a trigger rather than in application code means the domain
-- row exists before any request can run, so there is no window where a
-- signed-in user has no profile and no race between concurrent first
-- requests.

create or replace function handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.users (auth_user_id, email, phone_e164, email_verified_at)
  values (new.id, new.email, new.phone, new.email_confirmed_at)
  on conflict (auth_user_id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function handle_new_auth_user();

-- Backfill any auth users that predate this trigger.
insert into public.users (auth_user_id, email, phone_e164, email_verified_at)
select au.id, au.email, au.phone, au.email_confirmed_at
from auth.users au
left join public.users u on u.auth_user_id = au.id
where u.id is null
  and (au.email is not null or au.phone is not null);
