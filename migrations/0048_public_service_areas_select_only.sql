-- 0008 granted select on public_service_areas. Supabase's default
-- privileges had already granted anon and authenticated everything, and a
-- grant does not displace what is already there, so the view carried
-- insert, update, delete, truncate, trigger and references as well.
--
-- Nothing could use them: the view joins three tables, so Postgres
-- refuses to make it auto-updatable. That is the join saying no, not the
-- privilege system, and it would stop saying no if the view were ever
-- simplified. The two retention clocks in 0047 are what that looks like
-- when the shape does allow writes.
--
-- Select stays. It is how a visitor sees which neighbourhoods a provider
-- covers, and 0047 explains why this view is still a definer view.

revoke all on public_service_areas from anon, authenticated;
grant select on public_service_areas to anon, authenticated;
