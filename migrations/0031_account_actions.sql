-- 0031  Account consequences, and making users.status mean something.
--
-- From the owner's legal pass: consequences are account-based, never
-- monetary. "Refund the wronged neighbor; remove the jerk."
--
-- ## users.status existed and nothing read it
--
-- 0001 created it with a check constraint allowing active, suspended and
-- closed, and in twenty-eight migrations since, no code has ever set it or
-- checked it. A suspended account could do everything an active one could.
--
-- That is the fifth thing in this codebase declared and never wired: the
-- draft-to-active service transition, the customer role grant, the
-- guardian VERIFY event, the audit actor role, and now this. The pattern
-- is worth naming -- a column or a permission gets added with the design,
-- the step that uses it is left for later, and nothing fails in the
-- meantime because absence is silent.
--
-- This migration adds the history. The enforcement is in the application:
-- guard() refuses a permissioned action from a non-active account, so the
-- status is checked on every action rather than trusted at sign-in.
--
-- ## Append-only, like consents
--
-- A suspension is lifted by writing a reinstatement, not by deleting the
-- suspension. Standing is derived from the whole history in
-- domain/enforcement.ts, so a flag cannot be set and forgotten and the
-- record of what happened survives the account being restored.

create type account_action_kind as enum ('strike', 'suspend', 'ban', 'reinstate');

create table account_actions (
  id            uuid primary key default gen_random_uuid(),

  subject_user_id uuid not null references users(id) on delete restrict,
  kind          account_action_kind not null,

  -- Long enough to mean something to whoever reads it later. Same rule as
  -- every other staff action: see domain/incident.ts checkReason.
  reason        text not null check (length(trim(reason)) >= 20),

  -- What it came from, when it came from something.
  incident_id   uuid references incidents(id) on delete restrict,

  actor_user_id uuid not null references users(id) on delete restrict,
  actor_role    text,

  created_at    timestamptz not null default now(),

  -- Nobody sanctions themselves. A staff member acting on their own account
  -- is either a mistake or something that should go through somebody else.
  constraint actor_is_not_the_subject
    check (actor_user_id <> subject_user_id)
);

create index ix_account_actions_subject on account_actions (subject_user_id, created_at);

-- Same append-only trigger as consent_records, for the same reason: the
-- history is the record, and an UPDATE would rewrite what happened.
create or replace function account_actions_are_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'account_actions is append-only: % refused. Write a reinstatement instead.',
    tg_op;
end;
$$;

create trigger account_actions_no_update
  before update on account_actions
  for each row execute function account_actions_are_append_only();

create trigger account_actions_no_delete
  before delete on account_actions
  for each row execute function account_actions_are_append_only();

alter table account_actions enable row level security;
alter table account_actions force row level security;
revoke all on account_actions from anon, authenticated;

-- No client read at all, not even your own. A person is told their standing
-- in words by the application; handing them the reason text and the
-- incident id would let them work out who reported them.
comment on table account_actions is
  'Append-only history of strikes, suspensions, bans and reinstatements. Standing is derived in domain/enforcement.ts, never stored as a flag. No client read: the reason text would identify reporters.';
