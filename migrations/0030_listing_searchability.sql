-- 0030  Whether a published storefront may be found, as opposed to reached.
--
-- The legal pass draws a line the product did not have: a minor's listing
-- is reachable by its direct link and QR code always -- that is the
-- intended primary flow and does not change -- but it must not be
-- findable, indexed, or listed anywhere, until a guardian separately signs
-- the Public Listing Consent.
--
-- ## Why a boolean here as well as the consent id
--
-- businesses.public_listing_consent_id (0029) records WHY. This records
-- WHAT, because the two are not the same question and only one of them is
-- readable in the place it is needed.
--
-- The public storefront reads through the anon client. provider_profiles
-- is revoked from anon entirely and should stay that way, so the page
-- cannot ask "is this provider a minor" -- which is exactly the question
-- the rule turns on. Same shape as public_trust_badge in 0027: decide
-- server-side where the facts are, publish only the conclusion.
--
-- An adult provider is searchable on publish. A minor is not, until the
-- consent exists. Nothing on the public page has to know which is which,
-- which is also the privacy-preserving outcome.
--
-- Default false. A business that has never been evaluated is not findable,
-- and the failure mode of getting this wrong is a minor's listing in a
-- search engine -- so it fails closed.

alter table businesses
  add column searchable boolean not null default false;

create index ix_businesses_searchable on businesses (slug)
  where state = 'published' and searchable;

comment on column businesses.searchable is
  'May this published listing be indexed or listed in discovery? Direct link and QR always work regardless. False for a minor until a guardian signs the Public Listing Consent; set at publish for an adult. Fails closed.';
