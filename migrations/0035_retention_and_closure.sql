-- 0035  Retention periods, account closure, and de-identification.
--
-- TECHNICAL_SPEC section 23 asks for a configurable retention policy by
-- entity class, with no class defaulting to indefinite, and for user
-- deletion to honour legal and financial retention while removing what no
-- longer needs to be tied to a person.
--
-- The periods themselves live in src/domain/retention.ts, in one table,
-- with a written reason against each so counsel can overrule a number
-- rather than a guess. This file adds only what the database has to know.
--
-- ## Hard deletion of an account was never available, and this is why
--
-- Three tables already reference users with `on delete restrict`:
-- consent_records.signer_user_id, completion_photos.uploaded_by_user_id,
-- and the ledger's provider reference. Any attempt to delete a user who
-- has ever signed a consent, uploaded a photo, or earned a cent fails on
-- a foreign key.
--
-- That was not a decision anyone recorded, but it is the correct one, so
-- it is now written down and built on rather than worked around. Closing
-- an account de-identifies it: the row and its references stay, and the
-- parts naming a person are replaced.
--
-- ## The consent trigger gets one narrow exception
--
-- 0029 made consent_records refuse UPDATE and DELETE from every role,
-- including the service role, and proved it. That is still what we want
-- for anything about the agreement itself.
--
-- But "nobody may rewrite a signature" and "this row is unchangeable for
-- all time" are different promises, and only the first is the one worth
-- keeping. The second means a signature is retained forever, which
-- section 23 forbids outright.
--
-- So the trigger now permits exactly one transition, and refuses every
-- other UPDATE and all DELETEs as before:
--
--   * only typed_name, user_agent and ip_hash may change;
--   * they may only be set to the redaction placeholder;
--   * only when the record is already past its retention period.
--
-- Everything that makes the record evidence of WHAT was agreed -- the
-- document text, its hash, the version, the itemized acknowledgements,
-- the timestamp, the parties' ids -- still cannot be touched by anyone.
--
-- Said plainly, because it is a real loss: after redaction the record
-- no longer carries the signature. It shows that an identified account
-- agreed to a specific document on a specific date, and no longer shows
-- the name that account typed. That is the intended effect of a retention
-- period expiring, and counsel should confirm seven years is the right
-- point for it to happen.

-- ---------------------------------------------------------------------------
-- Account closure
-- ---------------------------------------------------------------------------
-- users.status already had 'closed' as a legal value from 0001 and nothing
-- ever set it. These columns record what happened and when, which
-- 'closed' on its own cannot.

alter table users
  add column closed_at           timestamptz,
  add column deletion_requested_at timestamptz,
  -- Separate from closed_at: closure is the request, de-identification is
  -- the work. If the job fails halfway, this column is how the next run
  -- knows there is still something to do.
  add column de_identified_at    timestamptz;

comment on column users.deletion_requested_at is
  'When the account holder asked to be deleted. Distinct from closed_at: an account can be closed by staff without anyone requesting erasure.';
comment on column users.de_identified_at is
  'When contact details and display names were actually replaced. NULL on a closed account means the retention job has not finished with it yet.';

create index ix_users_pending_de_identification
  on users (closed_at)
  where closed_at is not null and de_identified_at is null;

-- ---------------------------------------------------------------------------
-- Indexes the retention sweep needs
-- ---------------------------------------------------------------------------
-- Each of these supports one "older than the cutoff" query per run. Without
-- them the sweep degrades into a sequential scan of the largest tables in
-- the database, daily, forever.

create index if not exists ix_notifications_created_at on notifications (created_at);
create index if not exists ix_completion_photos_created_at on completion_photos (created_at);
create index if not exists ix_consent_signed_at on consent_records (signed_at);

-- ---------------------------------------------------------------------------
-- Customer addresses: when did the last subscription there end?
-- ---------------------------------------------------------------------------
-- The retention clock for an address starts when nothing uses it any more,
-- not when it was entered. A customer with a live weekly service has had
-- the same address on file for two years and it is not stale; the same row
-- ninety days after they cancelled is a stranger's home address held for
-- no reason.
--
-- A view rather than a stored column, because the answer changes whenever a
-- subscription changes state and a column would have to be maintained by
-- every path that touches one. Missing that on a single path would silently
-- keep an address forever, which is the exact failure this migration exists
-- to prevent.

create or replace view address_retention_clock as
select
  a.id as address_id,
  a.customer_user_id,
  -- NULL means a live subscription still uses it: the clock has not started.
  case
    when exists (
      select 1 from subscriptions s
      where s.service_address_id = a.id
        -- payment_failed counts as live: it is a subscription being
        -- retried, and dropping the address mid-retry would leave a
        -- recoverable customer unserviceable.
        and s.state in ('active', 'pending', 'paused', 'payment_failed')
    ) then null
    else greatest(
      a.created_at,
      coalesce(
        (select max(s.updated_at) from subscriptions s where s.service_address_id = a.id),
        a.created_at
      )
    )
  end as clock_starts_at
from customer_addresses a;

comment on view address_retention_clock is
  'When an address stopped being needed. NULL while any live subscription still uses it. Derived rather than stored so no write path can forget to maintain it.';

-- ---------------------------------------------------------------------------
-- The narrow exception to consent immutability
-- ---------------------------------------------------------------------------

create or replace function consent_records_are_append_only()
returns trigger
language plpgsql
as $$
declare
  -- Mirrors LONG_RETENTION_DAYS in src/domain/retention.ts. Duplicated on
  -- purpose, the way this schema repeats every other domain invariant: the
  -- application decides when to redact, and the database independently
  -- refuses to let it happen early.
  retention interval := interval '7 years';
  placeholder text := '[removed on retention schedule]';
begin
  if tg_op = 'DELETE' then
    raise exception
      'consent_records is append-only: DELETE refused. Record a revocation as a new row.';
  end if;

  -- Everything that evidences WHAT was agreed is untouchable, always.
  if new.id is distinct from old.id
     or new.kind is distinct from old.kind
     or new.signer_user_id is distinct from old.signer_user_id
     or new.subject_user_id is distinct from old.subject_user_id
     or new.subscription_id is distinct from old.subscription_id
     or new.document_version is distinct from old.document_version
     or new.document_hash is distinct from old.document_hash
     or new.document_text is distinct from old.document_text
     or new.acknowledged_items is distinct from old.acknowledged_items
     or new.verification_method is distinct from old.verification_method
     or new.signed_at is distinct from old.signed_at
     or new.revokes_id is distinct from old.revokes_id
     or new.revocation_reason is distinct from old.revocation_reason
  then
    raise exception
      'consent_records is append-only: UPDATE refused. Only retention redaction of typed_name, user_agent and ip_hash is permitted.';
  end if;

  -- The only permitted change is redaction, and only to the placeholder.
  -- Setting typed_name to a DIFFERENT name is forging a signature and is
  -- refused by this branch, not merely discouraged.
  if new.typed_name is distinct from old.typed_name and new.typed_name <> placeholder then
    raise exception
      'consent_records: typed_name may only be replaced by the retention placeholder, never by another value.';
  end if;
  if new.user_agent is distinct from old.user_agent and new.user_agent is not null then
    raise exception 'consent_records: user_agent may only be cleared.';
  end if;
  if new.ip_hash is distinct from old.ip_hash and new.ip_hash is not null then
    raise exception 'consent_records: ip_hash may only be cleared.';
  end if;

  -- And not before its time. The clock is the later of the signature and
  -- the end of the guardian relationship it belongs to, so a consent for a
  -- relationship that is still live never becomes redactable, however old
  -- the signature is.
  if greatest(
       old.signed_at,
       coalesce(
         (select max(coalesce(g.revoked_at, g.updated_at))
            from guardian_relationships g
           where g.provider_user_id = old.subject_user_id
             and g.guardian_user_id = old.signer_user_id
             and g.state in ('revoked', 'expired')),
         old.signed_at
       )
     ) > now() - retention
  then
    raise exception
      'consent_records: redaction refused, record is inside its % retention period.', retention;
  end if;

  return new;
end;
$$;

comment on function consent_records_are_append_only() is
  'Refuses every DELETE and every UPDATE except retention redaction of typed_name, user_agent and ip_hash on a record past its retention period. See migration 0035.';

-- No new grants. authenticated still has no update or delete on this
-- table at all; the exception is reachable only by the service role, and
-- only through the retention job.
