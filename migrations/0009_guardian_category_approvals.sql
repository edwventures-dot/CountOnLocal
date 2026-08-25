-- 0009  Per-category guardian approvals.
--
-- PRD section 15: a guardian can "approve or revoke service-category
-- permissions". SAFETY_TRUST_POLICY section 6 requires it for every Tier B
-- category.
--
-- General guardian consent is not the same as consent to a specific kind of
-- work. A parent who agreed to their child returning bins has not thereby
-- agreed to them walking strangers' dogs, and the schema should not let one
-- stand in for the other.

create table guardian_service_approvals (
  id            uuid primary key default gen_random_uuid(),
  relationship_id uuid not null references guardian_relationships(id) on delete cascade,
  -- The catalog code rather than the row id: an approval should survive a
  -- catalog row being replaced, and it is the category the guardian agreed
  -- to, not a particular database row.
  catalog_code  text not null references service_catalog(code) on update cascade,
  approved_at   timestamptz not null default now(),
  revoked_at    timestamptz,
  approved_by_user_id uuid not null references users(id),
  unique (relationship_id, catalog_code)
);

create index ix_guardian_approvals_relationship
  on guardian_service_approvals (relationship_id)
  where revoked_at is null;

alter table guardian_service_approvals enable row level security;

-- Both parties may see what has been approved. A provider needs to know
-- which categories are open to them; a guardian needs to see what they have
-- agreed to.
create policy guardian_approvals_read_party on guardian_service_approvals
  for select to authenticated
  using (
    exists (
      select 1 from guardian_relationships gr
      where gr.id = relationship_id
        and (gr.provider_user_id = app_current_user_id()
             or gr.guardian_user_id = app_current_user_id())
    )
  );

-- No client writes: granting a category is a guardian action that must be
-- audited, so it goes through a server-side service.
revoke insert, update, delete on guardian_service_approvals from anon, authenticated;
revoke all on guardian_service_approvals from anon;
