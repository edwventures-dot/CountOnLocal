-- 0017  Let a provider read the addresses on their own route.
--
-- SAFETY_TRUST_POLICY section 3 lists exactly who may see a customer's
-- service address: that customer, the assigned provider when operationally
-- necessary, the guardian linked to a minor provider, and audited staff.
-- 0011 implemented only the first of those, so a provider currently cannot
-- read the address of a house they are standing in front of.
--
-- This adds the second. The other two are separate work: the guardian view
-- is step 8, and staff access is the admin console in step 10 -- and that
-- one must be audited per CLAUDE.md rule 9, which is precisely why it is
-- not folded in here. Provider access is routine and continuous; staff
-- access is exceptional and gets a paper trail. Giving them one policy
-- would either drown the audit log or leave staff access unlogged.
--
-- The policy is deliberately narrow. A provider sees an address only while
-- a live subscription connects it to a service on their own business. When
-- a customer cancels, the subscription leaves those states and the address
-- stops being readable -- there is no lingering access to a house that used
-- to be on the route.
--
-- Note this also exposes customer_addresses.access_notes, which is where
-- gate codes live. That is the point: the provider needs the code to do the
-- job. SAFETY_TRUST_POLICY section 14 governs the rest -- it must never
-- reach an email subject, a push preview, a log line or an analytics
-- payload, and no code in this repository may put it in one.

create policy customer_addresses_read_assigned_provider on customer_addresses
  for select to authenticated
  using (
    exists (
      select 1
      from subscriptions s
      join provider_services ps on ps.id = s.provider_service_id
      join businesses b on b.id = ps.business_id
      where s.service_address_id = customer_addresses.id
        and b.provider_user_id = app_current_user_id()
        -- Live states only. A cancelled or ended subscription takes the
        -- address with it.
        and s.state in ('pending', 'active', 'paused', 'payment_failed')
    )
  );

comment on policy customer_addresses_read_assigned_provider on customer_addresses is
  'SAFETY_TRUST_POLICY 3: the assigned provider may read a service address while a live subscription connects it to their business. Access ends when the subscription does.';
