-- 0026  A provider cannot be their own guardian.
--
-- This was reachable, not theoretical. POST /v1/guardian/invitations
-- returned the raw invitation token to the browser that requested it --
-- the provider's own -- and acceptGuardianInvitation never compared the
-- two parties. A thirteen-year-old could invite any address, read the
-- token out of the API response, and accept it while signed in as
-- themselves, producing a relationship with provider_user_id =
-- guardian_user_id and granting themselves the guardian role.
--
-- It stopped at guardian_started rather than verified, so no customer
-- could be charged. That was the NEXT control holding, not this one. A
-- safety control that only works because a later one catches the fallout
-- is a control that has already failed.
--
-- Both code paths are fixed. This is the line that stays true when
-- somebody writes a third one: a backfill, an admin tool, a repair script
-- run at 2am against production.
--
-- CLAUDE.md rule 2 makes guardian state a real state machine rather than a
-- boolean precisely because it decides whether a minor may be paid by
-- strangers. The database should refuse to store a state that means
-- nobody is actually supervising.

alter table guardian_relationships
  add constraint guardian_is_not_self
  check (guardian_user_id is null or guardian_user_id <> provider_user_id);

comment on constraint guardian_is_not_self on guardian_relationships is
  'A provider cannot be their own guardian. NULL is allowed: an invitation exists before anyone has accepted it.';
