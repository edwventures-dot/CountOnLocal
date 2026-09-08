-- An active subscription no longer needs a card on file.
--
-- subscriptions carried `check (state <> 'active' or stripe_payment_method_id
-- is not null)`. It was a good constraint: it made "active" mean "somebody
-- can actually be charged for this", so a subscription could not go live
-- against a card that was never collected.
--
-- Nothing can be charged here, so the constraint made `active` unreachable
-- and every subscription attempt failed with WRITE_FAILED. Found by the
-- integration test written to replace the one deleted with checkout --
-- which is the argument for having written it, because the failure is
-- invisible from the application code and reads as a generic write error.
--
-- ## The same caveat as migration 0045
--
-- This branch shares a Supabase project with main, and dropping the
-- constraint removes the invariant there too. Main is parked at
-- v0-full-marketplace and its payment code enforces the same rule before
-- ever writing the row, so nothing there is currently relying on the
-- database to catch it -- but this is the second schema change made here
-- that quietly weakens the other branch.
--
-- Two is enough. Before this branch is put in front of anyone, it needs
-- its own project.

alter table subscriptions drop constraint if exists active_requires_payment_method;

do $$
declare
  c text;
begin
  -- The constraint may have been created with a generated name rather than
  -- the one above, depending on how it was written. Find it by definition
  -- instead of guessing, and drop whatever is actually there.
  select conname into c
  from pg_constraint
  where conrelid = 'public.subscriptions'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%stripe_payment_method_id%';

  if c is not null then
    execute format('alter table subscriptions drop constraint %I', c);
  end if;
end $$;

comment on column subscriptions.stripe_payment_method_id is
  'Always null on the adults-only, no-payments branch. Populated by the full product, where an active subscription cannot exist without one.';
