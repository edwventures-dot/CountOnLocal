-- 0012  Enum types for subscriptions, occurrences and the ledger.
--
-- Alone in its own file for the same reason as 0010: the runner sends each
-- file as one batch and Postgres parses it all before executing any of it,
-- so a table declared in the same file as the type it uses fails at parse
-- time.

create type subscription_state as enum (
  'pending','active','paused','payment_failed','canceled','ended'
);

create type occurrence_state as enum (
  'scheduled','due_today','started','completed','settled',
  'provider_skipped','customer_skipped','issue_reported','credited','canceled'
);

create type ledger_kind as enum (
  'customer_charge','platform_fee','provider_earning',
  'credit','refund','dispute','payout','adjustment'
);
