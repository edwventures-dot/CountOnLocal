-- 0036  Fix: a live guardian relationship must block consent redaction.
--
-- 0035 said this, in a comment directly above the check:
--
--   "a consent for a relationship that is still live never becomes
--    redactable, however old the signature is"
--
-- The code did not do that. The subquery it used only matched
-- relationships in state 'revoked' or 'expired'. A LIVE relationship
-- therefore matched nothing, the subquery returned NULL, coalesce fell
-- back to old.signed_at, and an eight-year-old signature on a guardianship
-- that is still in force became redactable -- exactly the case the comment
-- promised was impossible.
--
-- It is a quiet failure of the worst kind: it needs a signature seven
-- years old to trigger, so nothing would have surfaced it until 2033, at
-- which point the affected records are the oldest and least reconstructable
-- ones in the database.
--
-- Fixed by asking the question directly instead of inferring it from an
-- aggregate: if any relationship between these two parties is not over,
-- refuse, and only then consider the clock.

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
  clock_starts_at timestamptz;
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

  -- A relationship that has not ended has no retention clock running at
  -- all. Asked as its own question rather than inferred from an aggregate,
  -- which is how 0035 got this wrong.
  if old.subject_user_id is not null and exists (
    select 1 from guardian_relationships g
     where g.provider_user_id = old.subject_user_id
       and g.guardian_user_id = old.signer_user_id
       and g.state not in ('revoked', 'expired')
  ) then
    raise exception
      'consent_records: redaction refused, the guardian relationship is still in force.';
  end if;

  -- The clock is the later of the signature and the end of the
  -- relationship it belongs to. A consent revoked last week is retained
  -- from last week, not from the day it was signed years ago.
  select greatest(
           old.signed_at,
           coalesce(
             (select max(coalesce(g.revoked_at, g.updated_at))
                from guardian_relationships g
               where g.provider_user_id = old.subject_user_id
                 and g.guardian_user_id = old.signer_user_id),
             old.signed_at
           )
         )
    into clock_starts_at;

  if clock_starts_at > now() - retention then
    raise exception
      'consent_records: redaction refused, record is inside its % retention period.', retention;
  end if;

  return new;
end;
$$;

comment on function consent_records_are_append_only() is
  'Refuses every DELETE and every UPDATE except retention redaction of typed_name, user_agent and ip_hash, and only once the guardian relationship has ended and its retention period has run out. See migrations 0035 and 0036.';
