-- 0019  What a guardian can see.
--
-- PRD section 15 lists it: the business and its public page, the approved
-- services, the service-area boundaries, the scheduled dates and the
-- customer addresses tied to actual jobs, and payout status. Up to now a
-- guardian could read their own profile, their relationship, and the
-- category approvals -- and nothing operational at all.
--
-- The sentence that shapes the whole migration is the last one in that
-- section: "Guardian cannot silently read unrelated private drafts or
-- export customer data for non-service purposes."
--
-- ## Two tiers, because the two kinds of data are not alike
--
-- Consent data -- the business, its services, the service area -- is what a
-- guardian needs in order to decide. Withholding it until they have decided
-- would be circular, so it opens as soon as they have started
-- (guardian_started onward).
--
-- Operational data -- who the customers are, where they live, what the gate
-- code is -- is somebody else's private information, and a guardian who has
-- not actually consented has no claim on it. It opens only at `verified`.
--
-- ## Why `revoked` keeps operational access
--
-- SAFETY_TRUST_POLICY section 2 says that on revocation "already-paid
-- pending service occurrences are surfaced to support/guardian for safe
-- resolution". A guardian who has just pulled the plug is exactly the
-- person who needs to see which visits are outstanding. Cutting their
-- access at the moment they use it would make that clause unimplementable.
--
-- `expired` and `invited` get nothing: one is a lapsed relationship, the
-- other is somebody who has been asked and has not answered.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Is the caller a guardian of this provider, at consent level or beyond?
create or replace function app_guardian_may_consent(p_provider_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from guardian_relationships gr
    where gr.provider_user_id = p_provider_user_id
      and gr.guardian_user_id = app_current_user_id()
      and gr.state in ('guardian_started', 'verified', 'revoked', 'manual_review')
  );
$$;

-- Is the caller a guardian entitled to this provider's operational data --
-- customers, addresses, scheduled work?
create or replace function app_guardian_may_operate(p_provider_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from guardian_relationships gr
    where gr.provider_user_id = p_provider_user_id
      and gr.guardian_user_id = app_current_user_id()
      -- revoked included on purpose: see the header.
      and gr.state in ('verified', 'revoked')
  );
$$;

revoke all on function app_guardian_may_consent(uuid) from public;
revoke all on function app_guardian_may_operate(uuid) from public;
grant execute on function app_guardian_may_consent(uuid) to authenticated;
grant execute on function app_guardian_may_operate(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Consent tier
-- ---------------------------------------------------------------------------

create policy businesses_read_guardian on businesses
  for select to authenticated
  using (app_guardian_may_consent(provider_user_id));

create policy provider_services_read_guardian on provider_services
  for select to authenticated
  using (
    exists (
      select 1 from businesses b
      where b.id = business_id
        and app_guardian_may_consent(b.provider_user_id)
    )
  );

-- Boundaries, so a guardian can see where their kid has agreed to work.
create policy service_areas_read_guardian on service_areas
  for select to authenticated
  using (
    exists (
      select 1 from provider_services ps
      join businesses b on b.id = ps.business_id
      where ps.id = provider_service_id
        and app_guardian_may_consent(b.provider_user_id)
    )
  );

-- ---------------------------------------------------------------------------
-- Operational tier
-- ---------------------------------------------------------------------------

create policy subscriptions_read_guardian on subscriptions
  for select to authenticated
  using (
    exists (
      select 1 from provider_services ps
      join businesses b on b.id = ps.business_id
      where ps.id = provider_service_id
        and app_guardian_may_operate(b.provider_user_id)
    )
  );

create policy occurrences_read_guardian on service_occurrences
  for select to authenticated
  using (
    exists (
      select 1 from subscriptions s
      join provider_services ps on ps.id = s.provider_service_id
      join businesses b on b.id = ps.business_id
      where s.id = subscription_id
        and app_guardian_may_operate(b.provider_user_id)
    )
  );

-- "Customer addresses tied to actual jobs" -- PRD section 15. Tied is the
-- operative word: this reaches an address only through a live subscription
-- on the minor's own business, exactly as the provider policy in 0017 does.
-- A guardian cannot enumerate customer_addresses, and when a subscription
-- ends the address stops being visible to them too.
create policy customer_addresses_read_guardian on customer_addresses
  for select to authenticated
  using (
    exists (
      select 1
      from subscriptions s
      join provider_services ps on ps.id = s.provider_service_id
      join businesses b on b.id = ps.business_id
      where s.service_address_id = customer_addresses.id
        and app_guardian_may_operate(b.provider_user_id)
        and s.state in ('pending', 'active', 'paused', 'payment_failed')
    )
  );

-- The ledger stays closed. PRD section 15 gives a guardian "payout status",
-- which is a state, not a transaction history -- and the ledger carries
-- customer charges. Payout status is served from the provider's own account
-- fields through the API, not by opening the books.

comment on function app_guardian_may_consent(uuid) is
  'Guardian is at guardian_started or beyond: may see the business, services and service area in order to decide.';
comment on function app_guardian_may_operate(uuid) is
  'Guardian is verified, or revoked and resolving outstanding work: may see customers, addresses and scheduled visits.';
