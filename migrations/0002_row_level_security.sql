-- 0002  Row level security.
--
-- Without this, every table created in 0001 is world-readable AND
-- world-writable through the anon key -- which is embedded in the browser
-- bundle by design. Verified before writing this migration: an unauthenticated
-- caller could select from all six tables and successfully insert into users.
--
-- For this product that is not an abstract risk. The exposed rows include
-- every minor provider's date of birth and the audit log itself.
--
-- Model: deny by default. RLS is enabled everywhere, then narrow policies
-- grant back exactly what a signed-in user needs for their own records.
-- The service role bypasses RLS, so server-side privileged paths
-- (src/lib/supabase/admin.ts) continue to work unchanged.

-- ---------------------------------------------------------------------------
-- Link the domain user to the auth user.
-- ---------------------------------------------------------------------------
-- TECHNICAL_SPEC section 4 gives the domain its own immutable internal UUID,
-- and section 1 warns that vendors may change. So rather than making
-- users.id BE the Supabase auth id, we carry a nullable reference to it.
-- Swapping auth providers later means repointing this one column instead of
-- rewriting every foreign key in the schema.

alter table users
  add column auth_user_id uuid unique references auth.users(id) on delete cascade;

create index ix_users_auth_user on users (auth_user_id);

-- Resolves the calling auth user to their domain user id.
--
-- SECURITY DEFINER so it can read users regardless of the caller's own
-- policies -- otherwise the policies would recurse into themselves. STABLE
-- so Postgres evaluates it once per statement rather than once per row.
-- search_path is pinned to defeat search-path hijacking, which is the
-- standard footgun with definer functions.
create or replace function app_current_user_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select u.id from public.users u where u.auth_user_id = auth.uid()
$$;

revoke all on function app_current_user_id() from public;
grant execute on function app_current_user_id() to authenticated;

-- ---------------------------------------------------------------------------
-- Enable RLS. With RLS on and no matching policy, access is denied.
-- ---------------------------------------------------------------------------
alter table users                  enable row level security;
alter table user_roles             enable row level security;
alter table provider_profiles      enable row level security;
alter table guardian_profiles      enable row level security;
alter table guardian_relationships enable row level security;
alter table audit_log              enable row level security;

-- Force RLS for the table owner too, so a mistakenly-owner-authenticated
-- connection does not silently see everything.
alter table audit_log force row level security;

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
-- A user may read and update only their own row. Nobody may insert or
-- delete from the client: account creation goes through auth plus a
-- server-side path holding the service role.

create policy users_select_own on users
  for select to authenticated
  using (id = app_current_user_id());

create policy users_update_own on users
  for update to authenticated
  using (id = app_current_user_id())
  with check (id = app_current_user_id());

-- ---------------------------------------------------------------------------
-- user_roles
-- ---------------------------------------------------------------------------
-- Readable by the holder so the UI can render the right surfaces. Never
-- writable from the client -- a client-granted role would be a trivial
-- privilege escalation, and TECHNICAL_SPEC section 3 requires role changes
-- to be audited server-side.

create policy user_roles_select_own on user_roles
  for select to authenticated
  using (user_id = app_current_user_id());

-- ---------------------------------------------------------------------------
-- provider_profiles
-- ---------------------------------------------------------------------------
-- The provider only. Deliberately NOT extended to their linked guardian:
-- this row carries date_of_birth, and RLS grants whole rows, not columns.
-- The guardian dashboard (build-sequence step 8) gets a view that excludes
-- the DOB rather than a policy that would hand it over.
--
-- No insert or update policy for guardian_state: a provider must not be
-- able to move their own guardian state, which is the tampering case
-- QA_ACCEPTANCE section 3 calls out. Onboarding writes it server-side.

create policy provider_profiles_select_own on provider_profiles
  for select to authenticated
  using (user_id = app_current_user_id());

-- ---------------------------------------------------------------------------
-- guardian_profiles
-- ---------------------------------------------------------------------------

create policy guardian_profiles_select_own on guardian_profiles
  for select to authenticated
  using (user_id = app_current_user_id());

-- ---------------------------------------------------------------------------
-- guardian_relationships
-- ---------------------------------------------------------------------------
-- Visible to the two parties to it. Note this is a SELECT policy only:
-- creating, accepting and revoking all run through server-side services
-- that transition through the domain state machine and write an audit row.
-- Allowing a direct client update here would let either party skip both.
--
-- invitation_token_hash is in this row. That is acceptable because it is a
-- hash, not the token, and because only the two parties can read it.

create policy guardian_relationships_select_party on guardian_relationships
  for select to authenticated
  using (
    provider_user_id = app_current_user_id()
    or guardian_user_id = app_current_user_id()
  );

-- ---------------------------------------------------------------------------
-- audit_log
-- ---------------------------------------------------------------------------
-- No policies at all, by design. The log is append-only and readable only
-- through the service role. CLAUDE.md rule 9 requires admin access to
-- sensitive records to itself be audited; a client-side read path would
-- bypass that entirely.

-- ---------------------------------------------------------------------------
-- Belt and braces: withdraw the blanket grants Supabase issues to the
-- client roles on the public schema. RLS already denies these, but a
-- future policy added carelessly should not silently re-open a table.
-- ---------------------------------------------------------------------------
revoke insert, update, delete on users                  from anon, authenticated;
revoke all                    on user_roles             from anon, authenticated;
grant  select                 on user_roles             to   authenticated;
revoke insert, update, delete on provider_profiles      from anon, authenticated;
revoke insert, update, delete on guardian_profiles      from anon, authenticated;
revoke insert, update, delete on guardian_relationships from anon, authenticated;
revoke all                    on audit_log              from anon, authenticated;

-- anon keeps nothing at all on these tables. Every path that legitimately
-- needs unauthenticated access -- resolving a guardian invitation token --
-- runs through the service role in src/server/guardianService.ts.
revoke all on users                  from anon;
revoke all on provider_profiles      from anon;
revoke all on guardian_profiles      from anon;
revoke all on guardian_relationships from anon;
