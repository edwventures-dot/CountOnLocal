/**
 * Checkout (API_CONTRACT, Checkout / subscription).
 *
 * PRD section 10 is the flow: open the page, enter the address, verify
 * coverage, choose the plan, choose the earliest eligible start date,
 * review price and fee, confirm.
 *
 * The preview is deliberately complete before any account exists. A
 * neighbour holding a flyer should be able to see the real number --
 * including the platform fee and the billing cadence -- before being asked
 * to sign up for anything.
 */

import { z } from 'zod'

import {
  generateOccurrences,
  earliestStart,
  cycleWindow,
  isoDate,
  type ScheduleRule,
  type Weekday,
} from '@/domain/schedule'
import { resolveTimeZone } from '@/domain/jurisdiction'
import { parsePlainDate, todayUtc, type PlainDate } from '@/domain/calendar'
import { differsMaterially, parseNormalisedAddress } from '@/domain/normalisedAddress'
import { canAcceptNewSubscription } from '@/domain/gates'
import { loadProviderGateContext } from '@/server/providerGate'
import type { Role } from '@/domain/roles'
import { checkAddressEligibility, type AddressFields } from '@/server/eligibility'
import { writeAudit } from '@/server/audit'
import { recordConsent } from '@/server/consentService'
import { noticeToProviderAndGuardian } from '@/server/notices'
import { checkServiceDetails } from '@/domain/serviceDetails'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'

type Db = SupabaseClient<Database>

/** Default notice a provider gets before a new customer joins the route. */
export const DEFAULT_NOTICE_DAYS = 2

export const previewSchema = z.object({
  providerServiceId: z.string().uuid(),
  address: z.object({
    line1: z.string().trim().min(3).max(120),
    line2: z.string().trim().max(80).optional(),
    city: z.string().trim().min(1).max(80),
    region: z.string().trim().length(2).toUpperCase(),
    postalCode: z.string().trim().regex(/^[0-9]{5}(-[0-9]{4})?$/),
    countryCode: z.string().trim().length(2).toUpperCase().default('US'),
  }),
})
export type PreviewInput = z.infer<typeof previewSchema>

export type CheckoutPreview = {
  serviceName: string
  businessName: string
  businessSlug: string
  eligible: boolean
  normalizedAddress: string
  atCapacity: boolean
  priceCents: number
  priceUnit: 'week' | 'visit' | 'month'
  billingCycleWeeks: number
  earliestStartDate: string | null
  /** Service dates covered by the first billing cycle. */
  firstCycleDates: readonly string[]
}

export type PreviewResult =
  | {
      ok: true
      preview: CheckoutPreview
      /**
       * Internal only -- deliberately outside CheckoutPreview, which is the
       * API response shape. createSubscription persists this; nothing sends
       * it to a client.
       */
      point?: { latitude: number; longitude: number } | undefined
    }
  | {
      ok: false
      code:
        | 'SERVICE_NOT_FOUND'
        | 'ADDRESS_NOT_FOUND'
        | 'ADDRESS_AMBIGUOUS'
        | 'GEOCODER_UNAVAILABLE'
        | 'UNSUPPORTED_COUNTRY'
        | 'NO_SCHEDULE'
        // Jurisdiction refusals, from the eligibility check. Checkout must
        // carry them rather than collapsing them into a generic failure:
        // "not available in your state yet" is a different thing to tell
        // somebody than "we could not find that address".
        | 'STATE_BLOCKED'
        | 'SERVICE_BLOCKED_IN_STATE'
        | 'STATE_NOT_CLEARED'
        | 'PROVIDER_NOT_ELIGIBLE'
      /** Set for the jurisdiction refusals, which name the state. */
      message?: string | undefined
    }

/** Reads a stored schedule_rule into the domain shape. */
export function parseScheduleRule(raw: Record<string, unknown>): ScheduleRule | null {
  const freq = raw['frequency']
  const frequency =
    freq === 'weekly' || freq === 'every_2_weeks' || freq === 'every_4_weeks' ? freq : 'weekly'

  // Accept either a list of weekdays or the single `weekday` the earlier
  // builder wrote, so a service created before multi-day support still works.
  const list = Array.isArray(raw['weekdays'])
    ? (raw['weekdays'] as unknown[])
    : typeof raw['weekday'] === 'string'
      ? [raw['weekday']]
      : []

  const weekdays = list.filter((w): w is Weekday => typeof w === 'string') as Weekday[]
  if (weekdays.length === 0) return null

  return {
    frequency,
    weekdays,
    // Validated rather than trusted: this arrives from a browser. An
    // unrecognised zone falls back to Central, which is a last resort now
    // rather than the default it used to be.
    timezone: resolveTimeZone(typeof raw['timezone'] === 'string' ? raw['timezone'] : undefined),
    ...(typeof raw['windowStart'] === 'string' ? { windowStart: raw['windowStart'] } : {}),
    ...(typeof raw['windowEnd'] === 'string' ? { windowEnd: raw['windowEnd'] } : {}),
  }
}

async function countLiveSubscriptions(db: Db, providerServiceId: string): Promise<number> {
  const { count } = await db
    .from('subscriptions')
    .select('id', { count: 'exact', head: true })
    .eq('provider_service_id', providerServiceId)
    .in('state', ['pending', 'active', 'paused', 'payment_failed'])
  return count ?? 0
}

/**
 * Prices a prospective subscription, including whether the address is
 * covered and whether the route has room.
 *
 * Capacity is reported rather than enforced here -- the customer sees "this
 * route is full" instead of a coverage answer that quietly means something
 * else. PRD section 14 makes filling a route before widening it the whole
 * growth mechanic, so being full is a normal state, not an error.
 */
export async function previewCheckout(args: {
  db: Db
  input: PreviewInput
  now: Date
  noticeDays?: number
}): Promise<PreviewResult> {
  const { db, input, now } = args

  const { data: service } = await db
    .from('provider_services')
    .select(
      'id, public_name, price_cents, price_unit, billing_cycle_weeks, schedule_rule, capacity_rule, businesses!inner(name, slug, state)',
    )
    .eq('id', input.providerServiceId)
    .eq('state', 'active')
    .eq('businesses.state', 'published')
    .maybeSingle()

  if (!service) return { ok: false, code: 'SERVICE_NOT_FOUND' }

  const rule = parseScheduleRule(service.schedule_rule ?? {})
  if (!rule) return { ok: false, code: 'NO_SCHEDULE' }

  const eligibility = await checkAddressEligibility({
    db,
    providerServiceId: input.providerServiceId,
    address: input.address as AddressFields,
    // Needed to persist the point so a route can be ordered later without
    // geocoding the same house again.
    includePoint: true,
  })
  if (!eligibility.ok) {
    return {
      ok: false,
      code: eligibility.code,
      ...(eligibility.message === undefined ? {} : { message: eligibility.message }),
    }
  }

  const today = todayUtc(now)
  const start = earliestStart({
    rule,
    today,
    noticeDays: args.noticeDays ?? DEFAULT_NOTICE_DAYS,
  })

  const firstCycleDates =
    start === null
      ? []
      : (() => {
          const w = cycleWindow(start, service.billing_cycle_weeks)
          return generateOccurrences({ rule, start: w.start, through: w.end }).map(isoDate)
        })()

  const capacityMax = Number((service.capacity_rule as Record<string, unknown>)?.['maxAddresses'])
  const live = await countLiveSubscriptions(db, input.providerServiceId)
  const atCapacity = Number.isFinite(capacityMax) && capacityMax > 0 ? live >= capacityMax : false

  const business = service.businesses as unknown as { name: string; slug: string }

  return {
    ok: true,
    // Carried alongside the preview, not inside it: createSubscription
    // persists it so the route can be ordered without geocoding again.
    ...(eligibility.point ? { point: eligibility.point } : {}),
    preview: {
      serviceName: service.public_name,
      businessName: business.name,
      businessSlug: business.slug,
      eligible: eligibility.eligible,
      normalizedAddress: eligibility.normalizedAddress,
      atCapacity,
      priceCents: service.price_cents,
      priceUnit: service.price_unit,
      billingCycleWeeks: service.billing_cycle_weeks,
      earliestStartDate: start === null ? null : isoDate(start),
      firstCycleDates,
    },
  }
}

// ---------------------------------------------------------------------------
// Creating the subscription
// ---------------------------------------------------------------------------

export const createSubscriptionSchema = previewSchema.extend({
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  /** Anything the provider needs to know. "Bins are round the side." */
  customerInstructions: z.string().trim().max(500).optional(),
  /**
   * Per-category safety details. Required for dog services -- the
   * attestation the customer signs promises them.
   */
  serviceDetails: z.record(z.string(), z.unknown()).optional(),
  /**
   * The itemized customer attestation, from the legal pass.
   *
   * A list of acknowledged item keys plus a typed name, rather than a
   * single boolean. A boolean could record that somebody clicked; it could
   * not record WHAT they were told, which is the entire point of an
   * attestation saying Count On Local runs no background checks and does
   * not handle the money.
   *
   * Validated against domain/consent.ts and stored as a signed record.
   */
  attestation: z.object({
    acknowledgedItems: z.array(z.string().max(64)).min(1).max(32),
    typedName: z.string().trim().min(3).max(120),
  }),
})

export type CreateSubscriptionInput = z.infer<typeof createSubscriptionSchema>

export type CreateSubscriptionResult =
  | {
      ok: true
      subscriptionId: string
      state: 'active'
      startDate: string
      occurrenceCount: number
    }
  | {
      ok: false
      code:
        | 'SERVICE_NOT_FOUND'
        | 'NOT_ELIGIBLE'
        | 'AT_CAPACITY'
        | 'NO_SCHEDULE'
        | 'INVALID_START_DATE'
        | 'ALREADY_SUBSCRIBED'
        | 'ADDRESS_NOT_FOUND'
        | 'ADDRESS_AMBIGUOUS'
        | 'GEOCODER_UNAVAILABLE'
        | 'UNSUPPORTED_COUNTRY'
        | 'ATTESTATION_INVALID'
        | 'SERVICE_DETAILS_REQUIRED'
        | 'WRITE_FAILED'
        | 'PROVIDER_NOT_ELIGIBLE'
        // Same three as previewCheckout. Subscribing runs the preview
        // first, so a state closed between the preview and the confirm is
        // refused here rather than becoming a subscription nobody may
        // lawfully serve.
        | 'STATE_BLOCKED'
        | 'SERVICE_BLOCKED_IN_STATE'
        | 'STATE_NOT_CLEARED'
      message?: string
    }

/**
 * Creates the subscription and its first horizon of occurrences.
 *
 * Active immediately. In the full product this was `pending` until a card
 * cleared, and the gap between the two states was where abandoned
 * checkouts accumulated -- a subscription that existed, had never been paid
 * for, and could not be reached from anywhere. Nothing has to clear here,
 * so the state does not exist and neither does the dead end.
 *
 * Everything is re-checked rather than trusted from the preview the
 * customer saw. Between looking and confirming, a route can fill up or a
 * provider can unpublish.
 */
export async function createSubscription(args: {
  db: Db
  customerUserId: string
  input: CreateSubscriptionInput
  now: Date
  noticeDays?: number
  ip?: string | null
}): Promise<CreateSubscriptionResult> {
  const { db, customerUserId, input, now } = args

  const preview = await previewCheckout({
    db,
    input: { providerServiceId: input.providerServiceId, address: input.address },
    now,
    ...(args.noticeDays === undefined ? {} : { noticeDays: args.noticeDays }),
  })
  if (!preview.ok) {
    return {
      ok: false,
      code: preview.code,
      ...(preview.message === undefined ? {} : { message: preview.message }),
    }
  }
  if (!preview.preview.eligible) return { ok: false, code: 'NOT_ELIGIBLE' }
  if (preview.preview.atCapacity) return { ok: false, code: 'AT_CAPACITY' }
  if (preview.preview.earliestStartDate === null) return { ok: false, code: 'NO_SCHEDULE' }

  // Can this provider take a customer at all?
  //
  // This used to be asked only at activation -- which is after the customer
  // has read the attestation, signed it, and typed a card number. Being
  // told "this service is not taking new customers right now" at that point
  // is both a waste of their time and a worse disclosure than saying it
  // before they started.
  //
  // CLAUDE.md rule 2: a provider aged 13-17 cannot accept a paying customer
  // until the guardian relationship is verified. Activation still checks
  // again, because the guardian can be revoked between here and payment and
  // the check that guards the money must be the one next to the money.
  const gate = await providerCanAcceptSubscription({
    db,
    providerServiceId: input.providerServiceId,
    now,
  })
  if (!gate.ok) return { ok: false, code: 'PROVIDER_NOT_ELIGIBLE', message: gate.message }

  // A caller-supplied start date must be one the schedule actually offers,
  // and no earlier than the provider's notice window allows.
  const startDate = input.startDate ?? preview.preview.earliestStartDate
  if (startDate < preview.preview.earliestStartDate) {
    return { ok: false, code: 'INVALID_START_DATE' }
  }

  const { data: service } = await db
    .from('provider_services')
    .select('id, price_cents, price_unit, billing_cycle_weeks, schedule_rule')
    .eq('id', input.providerServiceId)
    .single()

  const rule = parseScheduleRule(service!.schedule_rule ?? {})
  if (!rule) return { ok: false, code: 'NO_SCHEDULE' }

  let start: PlainDate
  try {
    start = parsePlainDate(startDate)
  } catch {
    return { ok: false, code: 'INVALID_START_DATE' }
  }

  const window = cycleWindow(start, service!.billing_cycle_weeks)
  const scheduled = generateOccurrences({ rule, start: window.start, through: window.end })
  if (scheduled.length === 0 || isoDate(scheduled[0]!) !== startDate) {
    return { ok: false, code: 'INVALID_START_DATE' }
  }

  // What actually gets stored: the geocoder's reading of the address when
  // it produced one we can parse, and the customer's own entry when it did
  // not. Parsing refuses anything it does not recognise rather than
  // guessing, so an unfamiliar format falls back rather than putting a city
  // name in a postcode column.
  const verified = parseNormalisedAddress(preview.preview.normalizedAddress)
  const stored = verified ?? {
    line1: input.address.line1.trim(),
    city: input.address.city.trim(),
    region: input.address.region,
    postalCode: input.address.postalCode,
  }

  // Only recorded when it differs from what was stored -- otherwise every
  // address carries a duplicate of itself.
  const typedAddress =
    verified &&
    differsMaterially(
      {
        line1: input.address.line1,
        city: input.address.city,
        region: input.address.region,
        postalCode: input.address.postalCode,
      },
      verified,
    )
      ? `${input.address.line1}, ${input.address.city}, ${input.address.region}, ${input.address.postalCode}`
      : null

  // Reuse an address this customer already has, rather than inserting a new
  // row for the same house. Inserting unconditionally defeated the unique
  // index that prevents duplicate subscriptions, so a second Subscribe click
  // produced a second subscription and a second bill.
  const { data: existingAddress } = await db
    .from('customer_addresses')
    .select('id')
    .eq('customer_user_id', customerUserId)
    .ilike('line1', stored.line1)
    .ilike('city', stored.city)
    .eq('region', stored.region)
    .like('postal_code', `${stored.postalCode.slice(0, 5)}%`)
    .maybeSingle()

  const inserted = existingAddress
    ? { data: existingAddress, error: null }
    : await db
    .from('customer_addresses')
    .insert({
      customer_user_id: customerUserId,
      // The verified address, not the typed one. A tester entering ZIP
      // 77429 for an Austin house had it read as 78701 -- a different city
      // 165 miles away -- and the record kept saying Cypress. Staff
      // lookups, address deduplication and the density analytics all read
      // these columns.
      line1: stored.line1,
      line2: input.address.line2 ?? null,
      city: stored.city,
      region: stored.region,
      postal_code: stored.postalCode,
      country_code: input.address.countryCode,
      normalized_address: preview.preview.normalizedAddress,
      // What they actually typed, so a dispute can tell a bad geocode from
      // a bad entry. That was the stated intent here and it had never been
      // implemented.
      typed_address: typedAddress,
      geocoded_at: now.toISOString(),
      geocoder: 'us_census',
    })
    .select('id')
    .single()

  const address = inserted.data
  if (inserted.error || !address) {
    console.error('[subscribe] address write failed', inserted.error?.message)
    return { ok: false, code: 'WRITE_FAILED' }
  }

  // Keep the coordinates. Until 0018 they were used for the eligibility
  // check and discarded, which left the route with no idea where any house
  // was. A failure here is not fatal to checkout -- the subscription is
  // valid, the stop just orders last until the address is geocoded again.
  if (preview.point) {
    const { error: pointError } = await db.rpc('set_customer_address_point' as never, {
      p_address_id: address.id,
      p_lat: preview.point.latitude,
      p_lng: preview.point.longitude,
    } as never)
    if (pointError) {
      console.error('[subscribe] address point write failed', pointError.message)
    }
  }

  // Safety details for this category, checked against the catalog code the
  // service actually belongs to rather than anything the caller claimed.
  const { data: catalogRow } = await db
    .from('provider_services')
    .select('service_catalog!inner(code)')
    .eq('id', input.providerServiceId)
    .maybeSingle()
  const catalogCode =
    (
      (Array.isArray(catalogRow?.service_catalog)
        ? catalogRow?.service_catalog[0]
        : catalogRow?.service_catalog) as { code?: string } | undefined
    )?.code ?? null

  const details = checkServiceDetails({ catalogCode, input: input.serviceDetails })
  if (!details.ok) {
    return { ok: false, code: 'SERVICE_DETAILS_REQUIRED', message: details.message }
  }

  const { data: subscription, error: subError } = await db
    .from('subscriptions')
    .insert({
      customer_user_id: customerUserId,
      provider_service_id: input.providerServiceId,
      service_address_id: address.id,
      // Active on creation. In the full product this was 'pending' until
      // a card cleared, and the gap between the two was where abandoned
      // checkouts accumulated. Nothing has to clear here, so there is no
      // gap and no abandoned state to recover from.
      state: 'active',
      // The price is frozen at signup. A provider raising their price must
      // not silently reprice an existing customer -- still true when the
      // money changes hands between the two of them, because this is the
      // number both of them agreed to.
      provider_price_cents: service!.price_cents,
      price_unit: service!.price_unit,
      platform_fee_bps: 0,
      platform_fee_min_cents: 0,
      billing_cycle_weeks: service!.billing_cycle_weeks,
      current_cycle_start: isoDate(window.start),
      current_cycle_end: isoDate(window.end),
      customer_instructions: input.customerInstructions ?? null,
      service_details: details.details,
    })
    .select('id')
    .single()

  if (subError || !subscription) {
    if (subError?.code === '23505') {
      // ux_one_live_subscription counts 'pending' as live, which is right
      // A genuine duplicate. The unique index that produced this covers
      // (customer, service, address) across the live states, which is what
      // stops a second Subscribe click billing somebody twice -- and here,
      // what stops it putting two identical stops on a provider's round.
      return { ok: false, code: 'ALREADY_SUBSCRIBED' }
    }
    console.error('[subscribe] subscription write failed', subError?.message)
    return { ok: false, code: 'WRITE_FAILED' }
  }

  const perOccurrence =
    service!.price_unit === 'week' ? service!.price_cents : service!.price_cents

  const { error: occError } = await db.from('service_occurrences').insert(
    scheduled.map((date) => ({
      subscription_id: subscription.id,
      service_date: isoDate(date),
      local_timezone: rule.timezone,
      service_value_cents: perOccurrence,
      state: 'scheduled' as const,
      ...(rule.windowStart ? { service_window_start: rule.windowStart } : {}),
      ...(rule.windowEnd ? { service_window_end: rule.windowEnd } : {}),
    })),
  )

  if (occError) {
    console.error('[subscribe] occurrence generation failed', occError.message)
    return { ok: false, code: 'WRITE_FAILED' }
  }

  await writeAudit({
    actorUserId: customerUserId,
    actorRole: 'customer',
    action: 'subscription.created',
    targetType: 'subscription',
    targetId: subscription.id,
    after: {
      state: 'active',
      start_date: startDate,
      provider_price_cents: service!.price_cents,
      occurrences: scheduled.length,
    },
    ip: args.ip ?? null,
  })

  // The attestation, recorded against the subscription it was given for.
  //
  // After the subscription exists so the record can point at it, and
  // before anything else, because a failure here has to stop the whole
  // thing. An attestation is not optional garnish: it is the record of
  // what the customer was told about background checks and about who
  // handles the money. A subscription without one is a subscription
  // nobody can prove was informed.
  const attested = await recordConsent({
    db,
    kind: 'customer_attestation',
    signerUserId: customerUserId,
    subscriptionId: subscription.id,
    acknowledgedItems: input.attestation.acknowledgedItems,
    typedName: input.attestation.typedName,
    ipHash: null,
  })

  if (!attested.ok) {
    console.error('[subscribe] attestation refused', attested.code)
    return { ok: false, code: 'ATTESTATION_INVALID', message: attested.message }
  }

  // The provider needs to know somebody has joined their round, and this
  // is the only place that knows it happened. It used to be sent from
  // activation, after a card cleared -- there is no card and no activation,
  // so it moves here, to the moment the subscription becomes real.
  //
  // After the attestation, so a subscription nobody can prove was informed
  // does not generate a cheerful email about a new customer.
  const { data: ownerRow } = await db
    .from('provider_services')
    .select('businesses!inner ( provider_user_id )')
    .eq('id', input.providerServiceId)
    .maybeSingle()
  const ownerBiz = (
    Array.isArray(ownerRow?.businesses) ? ownerRow?.businesses[0] : ownerRow?.businesses
  ) as { provider_user_id?: string } | undefined

  if (ownerBiz?.provider_user_id) {
    await noticeToProviderAndGuardian({
      db,
      providerUserId: ownerBiz.provider_user_id,
      now,
      idempotencyKey: `new-subscriber:${subscription.id}`,
      kind: 'subscription.new_subscriber',
      subject: 'You have a new customer',
      preview: 'Somebody on your round has subscribed. Their first visit is on your schedule.',
      payload: { subscriptionId: subscription.id, startDate },
    })
  }

  return {
    ok: true,
    subscriptionId: subscription.id,
    state: 'active',
    startDate,
    occurrenceCount: scheduled.length,
  }
}

/**
 * Whether the provider behind a service may take a new customer.
 *
 * Lifted out of activationService so the question can be asked before the
 * customer commits rather than only after they have typed a card. Both
 * places ask it: this one to avoid wasting somebody's time, and activation
 * to guard the money, because a guardian can be revoked in between.
 *
 * The message is deliberately the same neutral sentence in every case. A
 * customer does not get to learn that a particular teenager's guardian
 * withdrew approval.
 */
async function providerCanAcceptSubscription(args: {
  db: Db
  providerServiceId: string
  now: Date
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const refused = { ok: false as const, message: 'This service is not taking new customers right now.' }

  const { data: row } = await args.db
    .from('provider_services')
    .select('businesses!inner ( provider_user_id )')
    .eq('id', args.providerServiceId)
    .maybeSingle()

  const biz = (Array.isArray(row?.businesses) ? row?.businesses[0] : row?.businesses) as
    | { provider_user_id?: string }
    | undefined
  const providerUserId = biz?.provider_user_id
  if (!providerUserId) return refused

  const { data: roleRows } = await args.db
    .from('user_roles')
    .select('role')
    .eq('user_id', providerUserId)

  const ctx = await loadProviderGateContext({
    db: args.db,
    providerUserId,
    roles: (roleRows ?? []).map((r) => r.role as Role),
    now: args.now,
  })
  if (!ctx) return refused

  return canAcceptNewSubscription(ctx).allowed ? { ok: true } : refused
}
