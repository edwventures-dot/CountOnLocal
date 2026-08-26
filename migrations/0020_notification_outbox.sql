-- 0020  The notification outbox.
--
-- TECHNICAL_SPEC section 12: "Business transaction writes a notification/
-- outbox record. Worker sends email/SMS. This prevents lost notifications
-- when an HTTP request succeeds but external messaging fails."
--
-- The failure this exists to prevent is specific. A guardian invitation
-- that returns 200 and never arrives is worse than one that returns 500:
-- the provider believes their guardian was asked, the guardian never hears
-- anything, and the account sits at `invited` until it expires. Writing the
-- intent in the same transaction as the thing that caused it means the
-- send can fail, retry, and still happen.
--
-- ## What may be in here
--
-- Two hard rules from CLAUDE.md, and they apply to the columns below rather
-- than to some later formatting step:
--
--   13. gate and access codes never reach an email subject, a push preview,
--       a log line or an analytics payload;
--    1. a customer's full address and a minor's private details are not
--       sent to analytics, and section 12 adds "no sensitive address or
--       access code in notification previews".
--
-- So `subject` and `preview` are the parts a phone shows on a lock screen,
-- and they are checked in the domain before a row is written. `payload`
-- carries the ids a template needs to look things up after the recipient
-- has authenticated -- not the values themselves.

create type notification_channel as enum ('email', 'sms', 'push');

create type notification_state as enum (
  'pending',    -- written, not yet attempted
  'sending',    -- claimed by a worker
  'sent',
  'failed',     -- retryable, will be picked up again
  'dead',       -- gave up; a human should look
  'suppressed'  -- deliberately not sent, e.g. no consent for this channel
);

create table notifications (
  id            uuid primary key default gen_random_uuid(),

  -- What happened. Matches the event names in PRD section 20.
  kind          text not null check (length(kind) between 3 and 64),
  channel       notification_channel not null,
  state         notification_state not null default 'pending',

  -- Who it is for. Nullable because a guardian invitation is addressed to
  -- somebody who does not have an account yet -- that is the whole point of
  -- an invitation.
  recipient_user_id uuid references users(id) on delete cascade,
  -- Destination as given. An email or an E.164 number.
  destination   text not null check (length(destination) between 3 and 320),

  -- Lock-screen safe. Enforced in domain/notification.ts before insert;
  -- the length caps here are a second line rather than the only one.
  subject       text check (subject is null or length(subject) <= 120),
  preview       text check (preview is null or length(preview) <= 200),

  -- Ids a template resolves AFTER the recipient authenticates. Never
  -- values that would be sensitive on their own.
  payload       jsonb not null default '{}'::jsonb,

  -- Dedupe. Two settlement runs for the same cycle must not send two
  -- receipts, so the caller supplies a key derived from the event.
  idempotency_key text unique,

  attempts      int not null default 0 check (attempts >= 0),
  last_error    text,
  -- Backoff: a worker only claims rows whose time has come.
  next_attempt_at timestamptz not null default now(),
  sent_at       timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint sent_has_timestamp check (state <> 'sent' or sent_at is not null)
);

-- The worker's query: pending or failed, due now, oldest first.
create index ix_notifications_claimable
  on notifications (next_attempt_at)
  where state in ('pending', 'failed');

create index ix_notifications_recipient on notifications (recipient_user_id, created_at desc);
create index ix_notifications_kind on notifications (kind, created_at desc);

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
-- Deny by default, and grants revoked so PostgREST returns 401 rather than
-- an empty list -- the lesson from 0016.
--
-- Nobody reads this through the API. It holds destinations, which are
-- contact details, and it holds rows addressed to people who do not have
-- accounts. The worker uses the service role; a "my notifications" feed, if
-- it is ever wanted, should be a deliberate narrow policy rather than a
-- side effect of this table existing.
alter table notifications enable row level security;
alter table notifications force row level security;
revoke all on notifications from anon, authenticated;

comment on table notifications is
  'Outbox. TECHNICAL_SPEC 12: written with the transaction that caused it, sent by a worker. subject/preview are lock-screen safe by construction -- never an address or an access code.';
