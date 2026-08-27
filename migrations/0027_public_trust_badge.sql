-- 0027  The trust badge a storefront is entitled to show.
--
-- The public page rendered "Guardian connected" for every published
-- business, with a comment reasoning that publishing requires a cleared
-- guardian so the page being visible is itself the evidence.
--
-- The hole is what "cleared" means. isGuardianCleared is true for both
-- `verified` AND `not_required`, and not_required is an adult who has no
-- guardian at all. So every adult provider's page claimed a supervising
-- adult that does not exist.
--
-- SAFETY_TRUST_POLICY section 19 lists `Guardian connected` as allowed
-- "when factual", and CLAUDE.md rule 10 says trust copy must be earned.
-- A badge shown to everyone is not evidence of anything.
--
-- ## Why a column rather than a join
--
-- provider_profiles is revoked from anon entirely, and should stay that
-- way: a minor's guardian state is not public data. The storefront reads
-- only public business rows through the anon client, and that discipline
-- is what keeps a page from accidentally selecting a date of birth.
--
-- So the badge is decided server-side at publish, when the real guardian
-- state and payout state are both in hand, and only the conclusion is
-- published. Staleness is handled the way the original comment intended:
-- a revoked guardian pauses the business, so an unpaused page always
-- carries a badge that was true when it went live and has not been
-- invalidated since.

alter table businesses
  add column public_trust_badge text
  check (public_trust_badge in ('guardian_connected', 'identity_verified'));

comment on column businesses.public_trust_badge is
  'Set at publish from the real guardian and payout state. NULL means no badge is earned and none is shown. guardian_connected requires a verified guardian; identity_verified requires a completed payout account. Never a default.';
