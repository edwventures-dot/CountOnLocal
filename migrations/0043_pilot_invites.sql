-- Invite-only accounts, for running one neighbourhood.
--
-- The pre-launch gate in src/lib/prelaunch.ts is all-or-nothing: it 404s
-- every path except the landing page, the waitlist and the legal documents.
-- Its own comment anticipated this moment -- "it should be replaced by real
-- per-market flags when the first market opens rather than being quietly
-- switched off" -- and switching it off is exactly what a neighbourhood
-- pilot would otherwise require. That would put subscription checkout and
-- provider onboarding on the public internet to run a test with fifteen
-- houses.
--
-- ## Why this is enforced in the database
--
-- Signup runs in the browser: AuthForm calls supabase.auth.signUp directly,
-- so the credential never touches this application's server. An invite code
-- checked in React would be a suggestion -- anyone can call the same
-- endpoint with curl and the project's public anon key, which is public by
-- design.
--
-- A trigger on auth.users is the only place that sees every account
-- creation regardless of who asked. Browser, curl, admin API, dashboard:
-- all of them insert here.
--
-- ## Why @example.com is always allowed
--
-- The integration suite creates users on every run, against this same
-- database, with addresses like procfee-provider-1757.@example.com.
-- example.com is reserved by RFC 2606 and can never be a real neighbour's
-- address, so allowing it lets 416 integration tests keep passing while the
-- gate is up. Without this the pilot flag would break the test suite the
-- moment it was switched on, which is how a safety control gets switched
-- back off.
--
-- ## Failing open
--
-- The flag defaults to off. An absent or unreadable setting means no
-- gating, because the asymmetry runs the other way from the prelaunch gate:
-- there, a mistake exposed payments to the public; here, a mistake locks
-- the owner out of their own signup with an opaque database error. The
-- prelaunch gate is still the thing standing between the product and the
-- internet until somebody deliberately lifts it.

create table pilot_invites (
  email       text primary key check (position('@' in email) > 1),
  note        text,
  invited_at  timestamptz not null default now(),
  redeemed_at timestamptz
);

comment on table pilot_invites is
  'Addresses allowed to create an account while pilot_invite_only is on. One neighbourhood at a time.';

alter table pilot_invites enable row level security;
alter table pilot_invites force row level security;
-- No client reads this. It is a list of the owner's neighbours' email
-- addresses and nothing in the product needs it; the trigger below runs as
-- definer and sees it regardless.
revoke all on pilot_invites from anon, authenticated;

insert into platform_settings (key, value, description) values (
  'pilot_invite_only',
  'off',
  'on = only addresses in pilot_invites may create an account, for running a single-neighbourhood pilot with the prelaunch gate lifted. off = anyone may sign up. Changing this changes who can join.'
);

create or replace function pilot_invite_only_enabled()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select value = 'on' from public.platform_settings where key = 'pilot_invite_only'),
    false
  );
$$;

create or replace function enforce_pilot_invite()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  addr text;
begin
  if not public.pilot_invite_only_enabled() then
    return new;
  end if;

  -- Phone-only signup has no address to check. Not used by this product,
  -- and refusing it here would be refusing something on a guess.
  if new.email is null then
    return new;
  end if;

  addr := lower(trim(new.email));

  -- The integration suite. See the note above.
  if addr like '%@example.com' then
    return new;
  end if;

  if exists (select 1 from public.pilot_invites where email = addr) then
    update public.pilot_invites
       set redeemed_at = now()
     where email = addr
       and redeemed_at is null;
    return new;
  end if;

  -- Read by src/domain/authErrors.ts, which turns it into a sentence a
  -- neighbour can act on. The code is in the message because a trigger
  -- cannot return structured data to PostgREST.
  raise exception 'PILOT_NOT_INVITED'
    using hint = 'This address has not been invited to the pilot.';
end;
$$;

-- BEFORE, so a refused signup never creates the auth row at all. An AFTER
-- trigger would raise too, but only once the credential existed, and a
-- half-created account is worse than a refusal.
create trigger enforce_pilot_invite_on_signup
  before insert on auth.users
  for each row
  execute function enforce_pilot_invite();
