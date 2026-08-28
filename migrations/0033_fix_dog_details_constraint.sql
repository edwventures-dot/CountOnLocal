-- 0033  The dog details constraint did not catch a missing field.
--
-- 0032 wrote:
--
--   and service_details->'dog'->>'biteHistory' in ('none','yes','unsure')
--
-- When biteHistory is absent, ->>'biteHistory' is NULL, NULL IN (...) is
-- NULL rather than false, and a CHECK constraint only rejects a row on
-- false. So a dog record with no bite history satisfied the constraint
-- that existed to require one.
--
-- That is precisely the case 0032's own comment named: "a bite history
-- that is absent reads as 'no' to anybody skimming." The application layer
-- refuses it correctly; this was supposed to be the second line and was
-- letting it through. Found by trying it rather than by reading it.
--
-- The same hole applied to size. `name is not null` was already right,
-- which is why it looked like the others were too.

alter table subscriptions drop constraint dog_details_are_complete;

alter table subscriptions
  add constraint dog_details_are_complete
  check (
    service_details->'dog' is null
    or (
      service_details->'dog'->>'name' is not null
      and service_details->'dog'->>'restraint' is not null
      -- Explicitly NOT NULL as well as in the list. A missing value would
      -- otherwise make the whole comparison NULL, which a CHECK accepts.
      and service_details->'dog'->>'size' is not null
      and service_details->'dog'->>'size' in ('small','medium','large')
      and service_details->'dog'->>'biteHistory' is not null
      and service_details->'dog'->>'biteHistory' in ('none','yes','unsure')
    )
  );
