-- 0038  Fix: two redacted addresses for one customer collide.
--
-- Found by the retention integration test, not by reading the code.
--
-- 0014 added a unique index over (customer_user_id, line1, line2, city,
-- region, postal_code) so two concurrent checkouts cannot create two rows
-- for the same house. Correct, and unrelated to retention until 0037
-- started emptying expired addresses to a fixed placeholder.
--
-- At that point every redacted address for a given customer has identical
-- values in every indexed column. The first one redacts; the second
-- collides and the whole sweep for that customer fails.
--
-- The case is not exotic. It is any customer who has ever moved house, or
-- had a second property on the account -- which is to say, exactly the
-- customer whose old address most needs clearing. The failure is also
-- permanent: the sweep retries daily and fails identically every time,
-- and the address stays on file indefinitely while the job reports the
-- error into a log nobody reads.
--
-- The fix is to say what the index actually means. It exists to stop two
-- rows describing the same LIVE house. Two emptied rows do not describe a
-- house at all, so they have no business being compared.

drop index if exists ux_customer_address_identity;

create unique index ux_customer_address_identity
  on customer_addresses (
    customer_user_id,
    lower(trim(line1)),
    coalesce(lower(trim(line2)), ''),
    lower(trim(city)),
    upper(trim(region)),
    left(postal_code, 5)
  )
  -- Redacted rows are excluded. They are tombstones held only because
  -- subscriptions.service_address_id is `on delete restrict`; deduplicating
  -- them is meaningless and, before this, impossible.
  where line1 <> '[removed on retention schedule]';

comment on index ux_customer_address_identity is
  'One row per live house per customer. Excludes addresses emptied by the retention sweep, which are tombstones and would otherwise all collide. See migrations 0014, 0037 and 0038.';
