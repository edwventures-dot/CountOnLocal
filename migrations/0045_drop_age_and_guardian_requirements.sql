-- Adults only: a provider profile no longer carries an age or a guardian.
--
-- This migration belongs to the free/no-payments branch. It makes two
-- columns optional rather than dropping them, and the distinction matters.
--
-- ## Why nullable and not dropped
--
-- This branch and main share one Supabase project. Dropping date_of_birth
-- would break every read on main, which still derives age bands from it on
-- every request. Making it nullable lets both branches run against the same
-- schema: main keeps writing and reading a birth date, and this branch
-- simply never writes one.
--
-- That is a compromise and it should not outlive the experiment. Two
-- products sharing one database will collide properly the moment a provider
-- created here is read by code there -- main calls parsePlainDate on a value
-- this branch leaves null. Before this branch is put in front of anyone,
-- it wants its own Supabase project.
--
-- ## Why the age question stopped being a column at all
--
-- The full product needed a date of birth because there were three bands to
-- place somebody in: under 13 refused, 13-17 gated on a guardian, 18+
-- independent. There is one band here, so the question is a yes/no -- and
-- FTC guidance says an operator who asks for and receives a date of birth
-- showing a user is under 13 has actual knowledge for COPPA purposes.
-- Asking would create an obligation that not asking does not.
--
-- So the answer is an attestation, stored as a consent record like every
-- other thing somebody agreed to, and no birth date is collected.

alter table provider_profiles alter column date_of_birth drop not null;
alter table provider_profiles alter column guardian_state drop not null;

comment on column provider_profiles.date_of_birth is
  'Null on the adults-only branch, which collects an attestation instead. Populated by the full product, which needs age bands.';

comment on column provider_profiles.guardian_state is
  'Null on the adults-only branch. Populated by the full product, where it is a real state machine.';

-- The consent kinds this branch uses. guardian_consent and
-- public_listing_consent stay in the enum because rows referencing them
-- exist and an enum value cannot be removed while it is in use -- and
-- because the records are the artifact of what somebody agreed to, which
-- outlives the feature.
alter type consent_kind add value if not exists 'provider_attestation';
