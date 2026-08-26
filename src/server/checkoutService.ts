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
import { quoteCycle, DEFAULT_FEE, type CycleQuote } from '@/domain/money'
import {
  generateOccurrences,
  earliestStart,
  cycleWindow,
  isoDate,
  type ScheduleRule,
  type Weekday,
} from '@/domain/schedule'
import { parsePlainDate, type PlainDate } from '@/domain/age'
import { checkAddressEligibility, type AddressFields } from '@/server/eligibility'
import { todayUtc } from '@/server/providerOnboarding'
import { writeAudit } from '@/server/audit'
import { attachReferral } from '@/server/referralService'
import { DEFAULT_REFERRAL_TERMS } from '@/domain/referral'
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
  quote: CycleQuote
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
    timezone: typeof raw['timezone'] === 'string' ? raw['timezone'] : 'America/Chicago',
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
  if (!eligibility.ok) return { ok: false, code: eligibility.code }

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
      quote: quoteCycle({
        priceCents: service.price_cents,
        priceUnit: service.price_unit,
        billingCycleWeeks: service.billing_cycle_weeks,
        fee: DEFAULT_FEE,
      }),
      earliestStartDate: start === null ? null : isoDate(start),
      firstCycleDates,
    },
  }
}

// ---------------------------------------------------------------------------
// Creating the subscription
// ---------------------------------------------------------------------------

export const createSubscriptionSchema = previewSchema.extend({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /**
   * UX_UI_SPEC section 13. Optional, and a bad one never fails the
   * checkout -- see attachReferral. Length is checked but the alphabet is
   * not, because rejecting on shape here would turn a typo into a
   * validation error on a form field the customer cannot fix by retyping
   * the code they were actually given.
   */
  referralCode: z.string().trim().min(1).max(16).optional(),
  customerInstructions: z.string().trim().max(500).optional(),
  /** PRD section 6: customers attest to being 18+ in V1. */
  adultAttestation: z.literal(true),
})
export type CreateSubscriptionInput = z.infer<typeof createSubscriptionSchema>

export type ReferralOutcome =
  | { applied: true; discountBps: number }
  /**
   * Surfaced rather than swallowed. A customer who typed a code and is
   * charged full price with no explanation has been quietly overcharged as
   * far as they are concerned.
   */
  | { applied: false; reason: string }

export type CreateSubscriptionResult =
  | {
      ok: true
      subscriptionId: string
      state: 'pending'
      startDate: string
      quote: CycleQuote
      occurrenceCount: number
      /** Absent when no code was supplied. */
      referral?: ReferralOutcome
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
        | 'WRITE_FAILED'
    }

/**
 * Creates a pending subscription and its first horizon of occurrences.
 *
 * `pending` rather than `active`: no money has moved yet. The subscription
 * becomes active when a payment method is attached and the first cycle is
 * charged, which keeps a half-finished checkout from putting a stranger on
 * a teenager's route.
 *
 * Everything is re-checked here rather than trusted from the preview the
 * customer saw. Between preview and confirm a route can fill up, a guardian
 * can revoke, or a provider can unpublish.
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
  if (!preview.ok) return { ok: false, code: preview.code }
  if (!preview.preview.eligible) return { ok: false, code: 'NOT_ELIGIBLE' }
  if (preview.preview.atCapacity) return { ok: false, code: 'AT_CAPACITY' }
  if (preview.preview.earliestStartDate === null) return { ok: false, code: 'NO_SCHEDULE' }

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

  // Reuse an address this customer already has, rather than inserting a new
  // row for the same house. Inserting unconditionally defeated the unique
  // index that prevents duplicate subscriptions, so a second Subscribe click
  // produced a second subscription and a second bill.
  const { data: existingAddress } = await db
    .from('customer_addresses')
    .select('id')
    .eq('customer_user_id', customerUserId)
    .ilike('line1', input.address.line1.trim())
    .ilike('city', input.address.city.trim())
    .eq('region', input.address.region)
    .like('postal_code', `${input.address.postalCode.slice(0, 5)}%`)
    .maybeSingle()

  // The address is stored with what the geocoder returned, so a later
  // dispute can tell "we geocoded it wrong" from "they typed it wrong".
  const inserted = existingAddress
    ? { data: existingAddress, error: null }
    : await db
    .from('customer_addresses')
    .insert({
      customer_user_id: customerUserId,
      line1: input.address.line1,
      line2: input.address.line2 ?? null,
      city: input.address.city,
      region: input.address.region,
      postal_code: input.address.postalCode,
      country_code: input.address.countryCode,
      normalized_address: preview.preview.normalizedAddress,
      geocoded_at: now.toISOString(),
      geocoder: 'us_census',
    })
    .select('id')
    .single()

  const address = inserted.data
  if (inserted.error || !address) {
    console.error('[checkout] address write failed', inserted.error?.message)
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
      console.error('[checkout] address point write failed', pointError.message)
    }
  }

  const { data: subscription, error: subError } = await db
    .from('subscriptions')
    .insert({
      customer_user_id: customerUserId,
      provider_service_id: input.providerServiceId,
      service_address_id: address.id,
      state: 'pending',
      // Price and fee terms are frozen at signup. A provider raising their
      // price must not silently reprice an existing customer.
      provider_price_cents: service!.price_cents,
      price_unit: service!.price_unit,
      platform_fee_bps: DEFAULT_FEE.percentBasisPoints,
      platform_fee_min_cents: DEFAULT_FEE.minimumCents,
      billing_cycle_weeks: service!.billing_cycle_weeks,
      current_cycle_start: isoDate(window.start),
      current_cycle_end: isoDate(window.end),
      customer_instructions: input.customerInstructions ?? null,
    })
    .select('id')
    .single()

  if (subError || !subscription) {
    if (subError?.code === '23505') return { ok: false, code: 'ALREADY_SUBSCRIBED' }
    console.error('[checkout] subscription write failed', subError?.message)
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
    console.error('[checkout] occurrence generation failed', occError.message)
    return { ok: false, code: 'WRITE_FAILED' }
  }

  await writeAudit({
    actorUserId: customerUserId,
    actorRole: 'customer',
    action: 'subscription.created',
    targetType: 'subscription',
    targetId: subscription.id,
    after: {
      state: 'pending',
      start_date: startDate,
      provider_price_cents: service!.price_cents,
      occurrences: scheduled.length,
    },
    ip: args.ip ?? null,
  })

  // After the subscription exists, because a referral points at one. A
  // failure here does not undo the subscription: the customer has bought
  // the service either way, and the reward is the part that is optional.
  let referral: ReferralOutcome | undefined
  if (input.referralCode) {
    const attached = await attachReferral({
      db,
      subscriptionId: subscription.id,
      customerUserId,
      code: input.referralCode,
    })

    if (attached.applied) {
      referral = { applied: true, discountBps: DEFAULT_REFERRAL_TERMS.customerDiscountBps }
      await writeAudit({
        actorUserId: customerUserId,
        actorRole: 'customer',
        action: 'referral.attached',
        targetType: 'subscription',
        targetId: subscription.id,
        after: { referral_id: attached.referralId },
        ip: args.ip ?? null,
      })
    } else {
      referral = { applied: false, reason: attached.reason }
    }
  }

  return {
    ok: true,
    subscriptionId: subscription.id,
    state: 'pending',
    startDate,
    quote: preview.preview.quote,
    occurrenceCount: scheduled.length,
    ...(referral ? { referral } : {}),
  }
}
