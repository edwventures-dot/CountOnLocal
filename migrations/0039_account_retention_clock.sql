-- 0039  When an account last showed a sign of life.
--
-- From the product owner's response of 2026-08-30, item 3:
--
--   "the handoff says nothing is retained indefinitely, but also says some
--    record classes have no separate erasure sweep and become de-identified
--    only when the account is closed. Reconcile that behavior so the code,
--    retention table, account-closure behavior, and policy all say the
--    same thing."
--
-- The inconsistency was real. The ledger, the audit log, incidents and
-- account actions carry no names -- only user ids -- so they stop being
-- personal data when the account row those ids point at stops naming a
-- person. That happens at closure. If nobody ever closes the account, it
-- never happens, and a seven-year period that nothing acts on is not a
-- retention period.
--
-- What was missing is a clock on the account itself. An account nobody has
-- touched in years is a relationship that ended without anyone saying so,
-- and it is the only remaining thing keeping those records tied to a
-- person.
--
-- ## Why a view, and why these tables
--
-- Same reason as address_retention_clock in 0035: a stored last_active_at
-- would have to be maintained by every write path in the application, and
-- missing one would silently hold an identity forever -- the exact failure
-- this exists to prevent. It also avoids a write on every authenticated
-- request purely to record that a request happened.
--
-- The signals are the ones that mean a real person did something:
--
--   * the account row changing at all (profile edits, verification,
--     Stripe onboarding -- users.updated_at is touched by all of them);
--   * a subscription moving, as a customer;
--   * money being credited or paid, as a provider;
--   * signing a consent.
--
-- Deliberately NOT included: notifications we sent them. Mail leaving the
-- platform is the platform being active, not the person, and counting it
-- would let an automated reminder keep an abandoned account alive forever.

create or replace view account_retention_clock as
select
  u.id as user_id,
  u.status,
  u.closed_at,
  u.de_identified_at,
  greatest(
    u.created_at,
    u.updated_at,
    coalesce((select max(s.updated_at) from subscriptions s
               where s.customer_user_id = u.id), u.created_at),
    coalesce((select max(l.created_at) from ledger_entries l
               where l.provider_user_id = u.id), u.created_at),
    coalesce((select max(c.signed_at) from consent_records c
               where c.signer_user_id = u.id), u.created_at)
  ) as last_active_at,
  -- Reasons an account must not be quietly retired out from under someone.
  -- Checked here so the job asks one question instead of three, and so the
  -- rule is visible to anyone reading the schema.
  exists (
    select 1 from subscriptions s
     where s.customer_user_id = u.id
       and s.state in ('pending', 'active', 'paused', 'payment_failed')
  ) as has_live_subscription
from users u;

comment on view account_retention_clock is
  'Last sign of real activity per account, for the dormancy sweep. Excludes notifications we sent: mail leaving the platform is the platform being active, not the person. See migration 0039 and src/domain/retention.ts.';
