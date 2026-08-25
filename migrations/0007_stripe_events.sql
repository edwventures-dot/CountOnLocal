-- 0007  Webhook event log.
--
-- TECHNICAL_SPEC section 11: webhook handlers must verify signatures,
-- persist raw event metadata, de-duplicate by external event ID, support
-- replay, and never assume ordering.
--
-- Stripe retries on any non-2xx and can deliver the same event more than
-- once even on success, so the event id is the primary key and a duplicate
-- insert is the de-duplication mechanism rather than a lookup-then-write
-- race.

create table stripe_events (
  id            text primary key,           -- Stripe's event id
  type          text not null,
  account_id    text,                       -- connected account, when the event names one
  api_version   text,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz,
  -- Kept for replay and for diagnosing an event we handled wrongly.
  -- Deliberately the envelope, not a payload dump: v2 thin events carry
  -- only references, and pulling the full object here would copy identity
  -- data into a second table for no operational gain.
  payload       jsonb not null,
  error         text
);

create index ix_stripe_events_account on stripe_events (account_id, received_at desc);
create index ix_stripe_events_unprocessed on stripe_events (received_at)
  where processed_at is null;

-- Never client-readable. Webhook traffic is platform infrastructure.
alter table stripe_events enable row level security;
alter table stripe_events force row level security;
revoke all on stripe_events from anon, authenticated;
