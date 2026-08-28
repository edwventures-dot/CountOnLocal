-- 0037  Clearing an address, including the part PostgREST cannot reach.
--
-- The retention sweep empties an address once nothing uses it any more.
-- Doing that over PostgREST leaves the one field that actually matters:
-- customer_addresses.point is a geography column, PostgREST cannot write a
-- geography literal, and 0018 already needed a function for the same
-- reason on the way in.
--
-- Clearing the street and leaving the coordinates would be theatre. The
-- point IS the address -- more precisely than the text, since the text can
-- be a typo and the point is where the geocoder actually put the house.
--
-- So redaction is one statement in one place, and the sweep calls it rather
-- than assembling the same UPDATE itself and being one column short.
--
-- Rows only, never a delete: subscriptions.service_address_id is
-- `on delete restrict` and a subscription outlives the address by years, so
-- the row has to survive to hold the foreign key. See src/domain/retention.ts.

create or replace function redact_customer_addresses(p_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  affected integer;
  placeholder text := '[removed on retention schedule]';
begin
  update customer_addresses
     set line1 = placeholder,
         line2 = null,
         city = placeholder,
         postal_code = '00000',
         normalized_address = null,
         access_notes = null,
         -- The whole reason this is a function.
         point = null,
         geocoded_at = null,
         geocoder = null,
         updated_at = now()
   where id = any(p_ids)
     -- Idempotent. Without this an already-cleared address is rewritten on
     -- every run forever and the count the job reports never reaches zero,
     -- which would make "did the sweep do anything today" unanswerable.
     and line1 <> placeholder;

  get diagnostics affected = row_count;
  return affected;
end;
$$;

-- The retention job only. A customer editing their own address goes through
-- the ordinary update path; this one empties a row wholesale and has no
-- business being reachable from a session.
revoke all on function redact_customer_addresses(uuid[]) from public, anon, authenticated;
grant execute on function redact_customer_addresses(uuid[]) to service_role;

comment on function redact_customer_addresses(uuid[]) is
  'Empties addresses past their retention period, including the geography point PostgREST cannot write. Idempotent. Service role only. See migration 0035 and src/domain/retention.ts.';
