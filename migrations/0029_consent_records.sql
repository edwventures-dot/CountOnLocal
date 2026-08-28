-- 0029  Signed consent records, and default-private minor listings.
--
-- From the owner's legal/safety pass (marketing/legal/DECISIONS_AND_DEMANDS.md
-- and DEV_HANDOFF_product-changes.md).
--
-- ## What "immutable" means here, precisely
--
-- Postgres cannot promise a row is unchangeable, and claiming otherwise in
-- a comment would be the kind of trust copy this project refuses elsewhere.
-- What this migration actually does:
--
--   * no UPDATE or DELETE grant to anon or authenticated, ever;
--   * a trigger that refuses UPDATE and DELETE from ANY role, including
--     the service role the application runs as;
--   * revocation recorded as a NEW ROW, not as a mutation of the old one.
--
-- So the application cannot rewrite a signature even by accident, and the
-- history of a consent is a sequence of rows rather than a field that got
-- overwritten. Someone with direct database ownership can still drop the
-- trigger; that is a backup-and-access-control problem, not one a schema
-- can solve, and it should be said out loud rather than papered over.
--
-- ## Why the document text is hashed rather than copied
--
-- ESIGN/UETA asks what the signer saw. The exact text lives in
-- src/domain/consent.ts, versioned, and the hash of its canonical form is
-- stored here. That makes a later wording change detectable: the stored
-- hash stops matching the current document, which is the signal that this
-- signature was given against something else.
--
-- The text itself is stored too. A hash proves a match; it does not let
-- anybody read what was agreed to years later, and the point of the record
-- is that a human can.

create type consent_kind as enum (
  'guardian_consent',
  'public_listing_consent',
  'customer_attestation'
);

create table consent_records (
  id            uuid primary key default gen_random_uuid(),

  kind          consent_kind not null,

  -- Who signed. Verified at signature time by whatever method is named in
  -- verification_method -- see the note on that column.
  signer_user_id uuid not null references users(id) on delete restrict,

  -- Which minor this is about. NULL for a customer attestation, which is
  -- about the signer themselves.
  subject_user_id uuid references users(id) on delete restrict,

  -- What the attestation was for, when it is tied to a purchase.
  subscription_id uuid references subscriptions(id) on delete restrict,

  -- The document as it stood.
  document_version text not null check (length(document_version) between 3 and 32),
  document_hash    text not null check (document_hash ~ '^[0-9a-f]{64}$'),
  document_text    text not null check (length(document_text) between 50 and 100000),

  -- Which individual points were checked. Itemized consent is the whole
  -- point: "did they agree to the messaging disclosure" must be answerable
  -- on its own, not inferred from one boolean.
  acknowledged_items text[] not null check (array_length(acknowledged_items, 1) > 0),

  -- What the signer typed. Their electronic signature under ESIGN/UETA.
  typed_name    text not null check (length(trim(typed_name)) between 3 and 120),

  -- How we knew who they were AT SIGNATURE TIME. Honest values only:
  -- 'authenticated_session' means they were signed in to a confirmed email
  -- account and nothing more. Do not write 'identity_verified' here unless
  -- an identity check actually happened.
  verification_method text not null check (length(verification_method) between 3 and 64),

  -- Hashed, never raw. Same treatment as the audit log.
  ip_hash       text,
  user_agent    text,

  signed_at     timestamptz not null default now(),

  -- Revocation is a separate row of kind matching the original, pointing
  -- back. This column marks that this row IS a revocation.
  revokes_id    uuid references consent_records(id) on delete restrict,
  revocation_reason text,

  constraint revocation_has_reason
    check (revokes_id is null or revocation_reason is not null),
  -- A guardian consent is always about somebody else; an attestation is
  -- always about the signer.
  constraint subject_matches_kind
    check (
      (kind = 'customer_attestation' and subject_user_id is null)
      or (kind <> 'customer_attestation' and subject_user_id is not null)
    ),
  constraint signer_is_not_the_subject
    check (subject_user_id is null or subject_user_id <> signer_user_id)
);

create index ix_consent_subject on consent_records (subject_user_id, kind);
create index ix_consent_signer on consent_records (signer_user_id, kind);
create index ix_consent_subscription on consent_records (subscription_id);

-- The teeth behind "immutable". Refuses from every role, not just the
-- unprivileged ones -- the application runs as the service role and must
-- not be able to rewrite a signature either.
create or replace function consent_records_are_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'consent_records is append-only: % refused. Record a revocation as a new row.',
    tg_op;
end;
$$;

create trigger consent_records_no_update
  before update on consent_records
  for each row execute function consent_records_are_append_only();

create trigger consent_records_no_delete
  before delete on consent_records
  for each row execute function consent_records_are_append_only();

alter table consent_records enable row level security;
alter table consent_records force row level security;
revoke all on consent_records from anon, authenticated;

-- A signer may read their own signatures back. They signed them; being
-- unable to see what you agreed to is its own problem.
grant select (
  id, kind, document_version, document_hash, document_text,
  acknowledged_items, typed_name, signed_at, revokes_id
) on consent_records to authenticated;

create policy consent_read_own on consent_records
  for select to authenticated
  using (signer_user_id = app_current_user_id());

comment on table consent_records is
  'Append-only signed consents (ESIGN/UETA). Enforced by trigger against every role. Revocation is a new row referencing revokes_id, never an update.';
comment on column consent_records.verification_method is
  'How the signer was identified AT SIGNATURE TIME. authenticated_session means a signed-in confirmed-email account and nothing stronger. Never claim more than happened.';

-- ---------------------------------------------------------------------------
-- Default-private minor listings
-- ---------------------------------------------------------------------------
--
-- A minor's storefront is reachable by its direct link and QR code always --
-- that is the intended primary flow and does not change. What this column
-- controls is whether it may be listed in search or indexed by a crawler.
--
-- Nullable with no default rather than `boolean not null default false`,
-- so the three states stay distinct: never asked, consented, withdrawn.
-- A plain false could not tell "the guardian said no" from "nobody has
-- been asked yet", and those need different prompts.

alter table businesses
  add column public_listing_consent_id uuid references consent_records(id) on delete restrict;

comment on column businesses.public_listing_consent_id is
  'Set when a guardian signs the Public Listing Consent. NULL means the listing is private: reachable by direct link and QR only, and not indexable. Cleared on revocation.';
