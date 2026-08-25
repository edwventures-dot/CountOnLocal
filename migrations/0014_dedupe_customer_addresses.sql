-- 0014  One address row per customer per physical address.
--
-- Found by the checkout tests: every checkout inserted a new
-- customer_addresses row, so the unique index guarding against duplicate
-- subscriptions -- keyed on (customer, service, address) -- never matched.
-- A customer clicking Subscribe twice got two subscriptions and two bills
-- for the same house.
--
-- The application now looks for an existing address before inserting. This
-- index is the guarantee behind that, so a race between two concurrent
-- checkouts cannot slip a second row through.

create unique index ux_customer_address_identity
  on customer_addresses (
    customer_user_id,
    lower(trim(line1)),
    coalesce(lower(trim(line2)), ''),
    lower(trim(city)),
    upper(trim(region)),
    left(postal_code, 5)
  );
