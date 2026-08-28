-- 0034  Completion photos.
--
-- PRD section 17 asks for one per completed visit, per service type.
-- Safety section 13 sets the rules: EXIF stripped before persistent
-- storage, private by default, public portfolio use only with separate
-- consent. The guardian consent has been promising these since the legal
-- pass; this is the field behind that promise.
--
-- ## Private bucket, and no signed URLs
--
-- The bucket is not public, and nothing hands out a signed URL. Every
-- fetch goes through an application route that checks who is asking --
-- CLAUDE.md rule 12 says "authorized on every fetch", and a signed URL is
-- authorized once and then valid for anybody who receives it. These are
-- photographs taken outside somebody's house by a child.
--
-- ## Why the path is opaque
--
-- Named by a random id rather than by occurrence or address. Storage keys
-- have a way of ending up in logs, backups and support tickets, and a key
-- like `customer-42/queen-street/2026-09-01.jpg` is a small data leak
-- every time it is written down.

insert into storage.buckets (id, name, public)
values ('completion-photos', 'completion-photos', false)
on conflict (id) do nothing;

create table completion_photos (
  id            uuid primary key default gen_random_uuid(),

  occurrence_id uuid not null references service_occurrences(id) on delete restrict,
  -- Denormalised so authorization can be decided without walking back
  -- through the occurrence on every fetch.
  subscription_id uuid not null references subscriptions(id) on delete restrict,

  uploaded_by_user_id uuid not null references users(id) on delete restrict,

  -- Opaque key inside the private bucket.
  storage_path  text not null unique check (length(storage_path) between 8 and 200),
  content_type  text not null check (content_type in ('image/jpeg', 'image/png')),
  byte_size     integer not null check (byte_size > 0 and byte_size <= 8388608),

  -- How many metadata segments were removed on the way in. Recorded so a
  -- later audit can tell "there was nothing to strip" from "stripping did
  -- not run", which look identical in the stored bytes.
  stripped_segments integer not null default 0,

  created_at    timestamptz not null default now(),

  -- One per visit for now. PRD allows more per service type later; a
  -- second row would need this dropped deliberately rather than by
  -- accident.
  constraint one_photo_per_occurrence unique (occurrence_id)
);

create index ix_completion_photos_subscription on completion_photos (subscription_id);

alter table completion_photos enable row level security;
alter table completion_photos force row level security;
revoke all on completion_photos from anon, authenticated;

-- No client read of the row either. The metadata names an occurrence and a
-- subscription; who may see the image is decided in one place, by the
-- fetch route, and a second path through PostgREST would be a second set
-- of rules to keep in step.
comment on table completion_photos is
  'One photo per completed visit. Bytes live in the private completion-photos bucket; every fetch is authorized by the application. EXIF stripped before storage -- stripped_segments records that it ran.';
