-- Two views the retention job reads were reachable by anyone holding the
-- anon key, which ships in the browser bundle by design.
--
-- account_retention_clock (0039) and address_retention_clock (0035) were
-- created without a revoke, so Supabase's default privileges granted
-- anon and authenticated everything on them. Both are owned by postgres
-- and neither set security_invoker, so they ran with postgres's rights --
-- and postgres has BYPASSRLS. Row level security on users and
-- customer_addresses was therefore not consulted at all when the views
-- were read.
--
-- Both views are simple enough for Postgres to make them auto-updatable,
-- so this was not read-only: a delete against account_retention_clock
-- deleted rows from users. Verified on production on 2026-10-20 inside a
-- rolled-back transaction -- a seeded user was visible to anon through
-- the view and one anon delete removed it.
--
-- Nothing legitimate loses access. Every caller is the daily job, which
-- uses the service role (src/app/api/jobs/daily/route.ts), and
-- service_role keeps its grants and has BYPASSRLS of its own.

revoke all on account_retention_clock from anon, authenticated;
revoke all on address_retention_clock from anon, authenticated;

-- Defence in depth: if a later restore or a Supabase default re-grants
-- these, the reader's own row level security applies instead of
-- postgres's bypass.
alter view account_retention_clock set (security_invoker = on);
alter view address_retention_clock set (security_invoker = on);

-- public_service_areas is deliberately left as a definer view. It is the
-- sanctioned public projection of provider coverage, carrying its own
-- filter to published businesses and active services, and service_areas
-- has no anon select policy -- so making it an invoker view would return
-- nothing to visitors and empty the storefront map. Its grant is select
-- only (0008) and its joins make it non-updatable.
