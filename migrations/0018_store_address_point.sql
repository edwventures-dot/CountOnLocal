-- 0018  Actually store the geocoded point.
--
-- 0011 created customer_addresses.point as geography(Point, 4326) and put a
-- GIST index on it, and nothing has ever written to it. Checkout geocodes
-- the address, uses the coordinates to answer "is this house in the service
-- area", records geocoded_at and the geocoder name -- and then throws the
-- coordinates away.
--
-- That was survivable while eligibility was the only consumer, because it
-- passes latitude and longitude straight into address_point_is_eligible.
-- It stops being survivable at step 6: ordering a route needs to know where
-- the houses are, and re-geocoding eighteen addresses every time a provider
-- opens Today would be both slow and rude to the geocoder.
--
-- PostgREST cannot insert a geography literal, so writing the column needs a
-- function. SECURITY DEFINER because the caller is the server acting for a
-- customer who is mid-checkout, and search_path is pinned for the usual
-- reason -- an unpinned search_path on a definer function is a privilege
-- escalation waiting for someone to create a schema.

create or replace function set_customer_address_point(
  p_address_id uuid,
  p_lat double precision,
  p_lng double precision
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_lat is null or p_lng is null then
    return;
  end if;

  -- Guard against transposed arguments, which is the classic geocoding bug
  -- and produces a point in the wrong hemisphere rather than an error.
  if p_lat < -90 or p_lat > 90 or p_lng < -180 or p_lng > 180 then
    raise exception 'Coordinates out of range: lat=%, lng=%', p_lat, p_lng;
  end if;

  update customer_addresses
     set point = public.st_setsrid(public.st_makepoint(p_lng, p_lat), 4326)::public.geography
   where id = p_address_id;
end;
$$;

-- Callable by the server on behalf of a signed-in user. Not by anon: an
-- unauthenticated caller has no business moving a house.
revoke all on function set_customer_address_point(uuid, double precision, double precision) from public;
grant execute on function set_customer_address_point(uuid, double precision, double precision) to authenticated, service_role;

comment on function set_customer_address_point(uuid, double precision, double precision) is
  'Writes customer_addresses.point from a geocode. PostgREST cannot insert a geography literal directly.';
