-- 0032  Details a customer must give for particular kinds of work.
--
-- Today that means dogs. The customer attestation signed at checkout says
-- they will give "honest information about my dog (size, leash/harness,
-- and any bite history)", and until now there was nowhere to put it -- a
-- signed promise with no field behind it.
--
-- ## Why this is not in customer_instructions
--
-- That column already exists and would have held the text. But a provider
-- reading a paragraph on a phone at seven in the morning will not reliably
-- notice the sentence that says the dog has bitten someone. Structured
-- data can be rendered as a warning; prose can only be read.
--
-- Bite history is a safety input, not an administrative field. It decides
-- whether a fourteen-year-old should take an animal down a street.
--
-- jsonb rather than columns because it is per-category and there will be
-- more categories. The shape is validated in domain/serviceDetails.ts
-- before it ever reaches here, and the check below is the second line
-- rather than the only one.

alter table subscriptions
  add column service_details jsonb not null default '{}'::jsonb;

-- If a dog is described at all, it must be described completely. A partial
-- record is the failure mode this exists to prevent: a bite history that
-- is absent reads as "no" to anybody skimming.
alter table subscriptions
  add constraint dog_details_are_complete
  check (
    service_details->'dog' is null
    or (
      service_details->'dog'->>'name' is not null
      and service_details->'dog'->>'size' in ('small','medium','large')
      and service_details->'dog'->>'restraint' is not null
      and service_details->'dog'->>'biteHistory' in ('none','yes','unsure')
    )
  );

comment on column subscriptions.service_details is
  'Per-category safety details from the customer, validated in domain/serviceDetails.ts. Dog entries must be complete: a missing bite history reads as reassurance nobody gave.';
