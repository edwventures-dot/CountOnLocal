-- 0041  Keep what the customer typed, separately from what was verified.
--
-- customer_addresses stored the typed line1, city, region and postal_code,
-- with the geocoder's corrected string alongside in normalized_address and
-- nothing using it. The comment at the insert site said "the address is
-- stored with what the geocoder returned"; it never was.
--
-- Found by a tester entering ZIP 77429 for an Austin address. The geocoder
-- read it as 78701 and returned a point in Austin, so eligibility passed
-- and the subscription was correct -- while the stored record said the
-- house was in Cypress, 165 miles away. Everything that reads those fields
-- was quietly wrong with it: staff looking up an address, the dedupe that
-- stops one house becoming two rows, and the density analytics that decide
-- which areas are worth launching in.
--
-- So the structured columns become the verified address, and the raw entry
-- moves here. That preserves what the original comment was reaching for --
-- being able to tell "we geocoded it wrong" from "they typed it wrong" --
-- which is impossible once one of the two is discarded.

alter table customer_addresses
  add column typed_address text;

comment on column customer_addresses.typed_address is
  'Exactly what the customer entered, before the geocoder corrected it. Kept so a later dispute can tell a bad geocode from a bad entry. NULL on rows written before migration 0041, and on any address the geocoder could not resolve -- in which case the structured columns still hold the typed values.';
