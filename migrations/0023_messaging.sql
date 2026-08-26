-- 0023  Messaging.
--
-- PRD section 17: service-linked, contact and payment circumvention
-- blocked, minors get stricter controls, either party can report, admin
-- access audited, retention documented and implemented.
--
-- ## Threads hang off a subscription
--
-- Not off a pair of users. "Messaging is tied to a service/business
-- relationship" (SAFETY_TRUST_POLICY section 9) means exactly this: there
-- is no way to open a conversation with somebody you are not doing business
-- with, and when the business relationship ends the thread has a definite
-- owner and a definite retention clock rather than drifting into a general
-- inbox.
--
-- ## Blocked messages are stored
--
-- A refused message is not discarded. It is evidence about a minor's
-- safety, and the people who may need it are a guardian, trust and safety,
-- or eventually somebody outside the company. It is stored with
-- delivered = false so no recipient ever reads it.
--
-- That is also why there is no delete: a participant removing a message
-- they sent would be removing the record of having sent it.

create type message_state as enum (
  'delivered',   -- normal
  'blocked',     -- refused at send; retained as evidence, never shown
  'redacted'     -- taken down by trust and safety; body cleared
);

create table message_threads (
  id            uuid primary key default gen_random_uuid(),
  -- One thread per subscription. The relationship IS the thread.
  subscription_id uuid not null unique references subscriptions(id) on delete restrict,
  customer_user_id uuid not null references users(id) on delete restrict,
  provider_user_id uuid not null references users(id) on delete restrict,
  -- True when either party is a minor. Denormalised so a send does not need
  -- an age lookup, and refreshed when guardian state changes.
  involves_minor boolean not null default false,
  last_message_at timestamptz,
  created_at    timestamptz not null default now()
);

create index ix_threads_customer on message_threads (customer_user_id, last_message_at desc);
create index ix_threads_provider on message_threads (provider_user_id, last_message_at desc);

create table messages (
  id            uuid primary key default gen_random_uuid(),
  thread_id     uuid not null references message_threads(id) on delete cascade,
  sender_user_id uuid not null references users(id) on delete restrict,

  body          text not null check (length(body) between 1 and 2000),
  state         message_state not null default 'delivered',

  -- Why it was refused, when it was. Never shown to the other party.
  violation_code text,
  -- Trust and safety should look now rather than in the queue.
  urgent        boolean not null default false,

  -- Set when a participant reports it, separately from an automatic block.
  reported_at   timestamptz,
  reported_by_user_id uuid references users(id) on delete set null,
  report_reason text,

  read_at       timestamptz,
  -- Retention clock. Longer for anything flagged, because it is evidence.
  purge_after   timestamptz not null,

  created_at    timestamptz not null default now(),

  constraint blocked_has_reason
    check (state <> 'blocked' or violation_code is not null),
  constraint report_has_reporter
    check (reported_at is null or reported_by_user_id is not null)
);

create index ix_messages_thread on messages (thread_id, created_at);
create index ix_messages_purge on messages (purge_after);
-- The moderation queue: reported or auto-blocked, urgent first.
create index ix_messages_review
  on messages (urgent desc, created_at)
  where state = 'blocked' or reported_at is not null;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table message_threads enable row level security;
alter table messages enable row level security;
revoke all on message_threads from anon, authenticated;
revoke all on messages from anon, authenticated;

grant select (id, subscription_id, customer_user_id, provider_user_id, involves_minor, last_message_at, created_at)
  on message_threads to authenticated;
grant select (id, thread_id, sender_user_id, body, state, read_at, created_at)
  on messages to authenticated;

-- Either party reads their own thread. Nobody else does -- not a customer
-- of the same provider, not another provider.
create policy threads_read_party on message_threads
  for select to authenticated
  using (
    customer_user_id = app_current_user_id()
    or provider_user_id = app_current_user_id()
  );

-- Delivered messages only. A blocked message is retained as evidence and
-- must never reach the person it was aimed at -- which is the entire reason
-- it was blocked rather than delivered and flagged.
create policy messages_read_party on messages
  for select to authenticated
  using (
    state = 'delivered'
    and exists (
      select 1 from message_threads t
      where t.id = thread_id
        and (t.customer_user_id = app_current_user_id()
             or t.provider_user_id = app_current_user_id())
    )
  );

-- A guardian reads the thread of a minor they are verified for.
-- SAFETY_TRUST_POLICY section 9 keeps a minor's conversation visible to the
-- person responsible for them; 0019 established the same two-tier rule for
-- everything else operational.
create policy threads_read_guardian on message_threads
  for select to authenticated
  using (app_guardian_may_operate(provider_user_id));

create policy messages_read_guardian on messages
  for select to authenticated
  using (
    state = 'delivered'
    and exists (
      select 1 from message_threads t
      where t.id = thread_id and app_guardian_may_operate(t.provider_user_id)
    )
  );

-- No client writes. A send has to be checked against the content rules
-- before it lands, and a blocked one has to be stored without being
-- readable -- neither of which a policy can express.

comment on table messages is
  'PRD 17. Blocked messages are stored as evidence with state=blocked and are unreadable by any participant. No delete: removing a message would remove the record of having sent it.';
