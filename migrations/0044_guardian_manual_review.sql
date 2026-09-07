-- A person approves a young provider, not a form.
--
-- Until now a guardian signed the consent items and the relationship went
-- straight to `verified`, which is the state that lets a 13-to-17-year-old
-- accept a paying customer. Signature to live, with nobody in between.
--
-- The domain has always modelled the alternative. guardian.ts has a
-- `manual_review` state with REVIEW_APPROVE -> verified and REVIEW_DENY ->
-- revoked, and every other state can be flagged into it. Nothing ever
-- routed into it -- auditCoverage.test.ts carries the exemption saying so
-- in as many words: "manual_review is a reachable guardian state; nothing
-- routes into it yet".
--
-- ## Why the online consent is not enough on its own
--
-- A stranger clicking through eleven items on a screen cannot really give
-- informed consent to their child working for neighbours, however carefully
-- the items are worded. A conversation can. So the consent record stays
-- exactly as it was -- it is still the artifact, still immutable, still the
-- thing that says what was agreed -- and it stops being the last step.
--
-- The owner meets the family. The approval records that it happened.
--
-- ## Why this is a setting rather than a constant
--
-- Same reason as jurisdiction_posture and pilot_invite_only: it is a policy,
-- policies change, and a policy that needs a deploy to change is one that
-- gets changed in a hurry by someone who should not be deploying.
--
-- It defaults ON, which is the opposite of the other two flags. Those open
-- something when switched on; this one closes something when switched off,
-- and the safe default for a control protecting minors is the one that
-- makes somebody do the work.

insert into platform_settings (key, value, description) values (
  'guardian_manual_review',
  'on',
  'on = a guardian signing consent moves the relationship to manual_review, and a person must approve it before the minor can accept a paying customer. off = signing consent verifies the relationship immediately. Changing this changes whether a human sees a young provider before their first customer.'
);

create or replace function guardian_manual_review_enabled()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select value = 'on' from public.platform_settings where key = 'guardian_manual_review'),
    -- Absent means on. An unreadable setting must not silently drop the
    -- review step; the cost of a wrong 'on' is somebody waiting for a
    -- phone call, and the cost of a wrong 'off' is a minor going live
    -- unseen.
    true
  );
$$;

-- What the approval meeting produced. Separate from the consent record
-- because they are different artifacts by different people: the consent is
-- the guardian's signature on stated terms, and this is the operator's
-- record that they met the family and made a judgement.
--
-- Append-only, like consent_records and account_actions. An approval that
-- can be edited afterwards is not a record of what somebody decided at the
-- time, and this is the row that would matter most if anybody ever asked.
create table guardian_reviews (
  id                    uuid primary key default gen_random_uuid(),
  relationship_id       uuid not null references guardian_relationships(id) on delete restrict,
  provider_user_id      uuid not null references users(id) on delete restrict,
  guardian_user_id      uuid not null references users(id) on delete restrict,
  decision              text not null check (decision in ('approved', 'denied')),
  -- Free text from the person who made the call. Required: an approval
  -- with no reasoning is a rubber stamp wearing a record's clothes.
  reason                text not null check (length(trim(reason)) between 3 and 2000),
  -- Whether the meeting actually happened face to face, and who was there.
  -- The whole strength of this design is that it is a conversation; if the
  -- system only stores "approved", that strength is invisible later.
  met_in_person         boolean not null,
  present               text,
  reviewed_by_user_id   uuid not null references users(id) on delete restrict,
  reviewed_at           timestamptz not null default now()
);

create index guardian_reviews_relationship on guardian_reviews (relationship_id, reviewed_at desc);
create index guardian_reviews_provider on guardian_reviews (provider_user_id, reviewed_at desc);

comment on table guardian_reviews is
  'Operator decisions on young providers. Append-only: no update or delete.';

alter table guardian_reviews enable row level security;
alter table guardian_reviews force row level security;
revoke all on guardian_reviews from anon, authenticated;

create or replace function guardian_reviews_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'guardian_reviews is append-only';
end;
$$;

create trigger guardian_reviews_no_update
  before update on guardian_reviews
  for each row execute function guardian_reviews_immutable();

create trigger guardian_reviews_no_delete
  before delete on guardian_reviews
  for each row execute function guardian_reviews_immutable();
