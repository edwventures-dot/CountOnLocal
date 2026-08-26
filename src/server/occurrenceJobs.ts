/**
 * The two background jobs that keep the schedule alive.
 *
 * TECHNICAL_SPEC section 20: extend the occurrence horizon, and send the
 * day's reminders. CLAUDE.md rule 8: a rolling 8-12 week horizon extended
 * daily, never years of rows generated up front.
 *
 * ## On "today"
 *
 * Both jobs need to know what day it is, and the honest answer is that it
 * depends where you are standing. A Tuesday route in America/Chicago is
 * still Monday in UTC for six hours, so promoting occurrences by UTC date
 * would mark a whole route due before the provider has gone to bed.
 *
 * The fix is narrow and does not need a time zone library: ask Intl what
 * the civil date is in a given zone right now. That is a formatting
 * question with a definite answer, unlike converting a local service window
 * into an instant, which is the operation schedule.ts refuses to do because
 * it needs offset rules and gets DST wrong.
 *
 * en-CA is used purely because its short date format is ISO order.
 */

import {
  addDays,
  generateOccurrences,
  isoDate,
  type ScheduleRule,
} from '@/domain/schedule'
import { parseScheduleRule } from '@/server/checkoutService'
import { parseServiceDate } from '@/server/occurrenceService'
import type { PlainDate } from '@/domain/age'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'

type Db = SupabaseClient<Database>

/**
 * How far ahead to keep occurrences. CLAUDE.md rule 8 says 8-12 weeks; ten
 * sits in the middle, leaving room to run late without the horizon closing.
 */
export const HORIZON_WEEKS = 10

/** The civil date in `timeZone` at `instant`. */
export function civilDateIn(timeZone: string, instant: Date): PlainDate {
  const formatted = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant)
  return parseServiceDate(formatted)
}

export type ExtendResult = {
  subscriptionsConsidered: number
  subscriptionsExtended: number
  occurrencesCreated: number
  failures: Array<{ subscriptionId: string; reason: string }>
}

/**
 * Tops every active subscription back up to the horizon.
 *
 * Generates from the day after the last existing occurrence, so a
 * subscription that is already current costs one query and no writes. The
 * unique index on (subscription_id, service_date) is the real guard: even
 * if two runs overlap, the second cannot duplicate a visit.
 *
 * `db` must be the PRIVILEGED client -- this runs as a job with no user.
 */
export async function extendHorizon(args: {
  db: Db
  /** Instant the run represents. Injected so tests are not clock-dependent. */
  now: Date
  horizonWeeks?: number
}): Promise<ExtendResult> {
  const { db, now } = args
  const horizonWeeks = args.horizonWeeks ?? HORIZON_WEEKS

  const result: ExtendResult = {
    subscriptionsConsidered: 0,
    subscriptionsExtended: 0,
    occurrencesCreated: 0,
    failures: [],
  }

  // Paused and payment_failed subscriptions are deliberately excluded: work
  // should not be scheduled for a route the provider is not running or a
  // customer who is not paying. Resuming re-extends on the next run.
  const { data: subs, error } = await db
    .from('subscriptions')
    .select(
      `id, provider_price_cents, price_unit, billing_cycle_weeks,
       provider_services!inner ( schedule_rule )`,
    )
    .eq('state', 'active')

  if (error) {
    result.failures.push({ subscriptionId: '*', reason: `query failed: ${error.message}` })
    return result
  }

  for (const sub of subs ?? []) {
    result.subscriptionsConsidered++

    const svc = (Array.isArray(sub.provider_services)
      ? sub.provider_services[0]
      : sub.provider_services) as { schedule_rule: Record<string, unknown> | null } | undefined

    const rule: ScheduleRule | null = parseScheduleRule(svc?.schedule_rule ?? {})
    if (!rule) {
      result.failures.push({ subscriptionId: sub.id, reason: 'no usable schedule rule' })
      continue
    }

    const { data: last } = await db
      .from('service_occurrences')
      .select('service_date')
      .eq('subscription_id', sub.id)
      .order('service_date', { ascending: false })
      .limit(1)
      .maybeSingle()

    const today = civilDateIn(rule.timezone, now)
    const through = addDays(today, horizonWeeks * 7)

    // Start the day after the last one we have. With no occurrences at all
    // -- a subscription whose first cycle was cleaned up, say -- start from
    // today rather than backfilling history nobody will service.
    const from = last?.service_date ? addDays(parseServiceDate(last.service_date), 1) : today

    if (isoDate(from) > isoDate(through)) continue

    const dates = generateOccurrences({ rule, start: from, through })
    if (dates.length === 0) continue

    const { error: insertError, count } = await db.from('service_occurrences').insert(
      dates.map((date) => ({
        subscription_id: sub.id,
        service_date: isoDate(date),
        local_timezone: rule.timezone,
        service_value_cents: sub.provider_price_cents,
        state: 'scheduled' as const,
        ...(rule.windowStart ? { service_window_start: rule.windowStart } : {}),
        ...(rule.windowEnd ? { service_window_end: rule.windowEnd } : {}),
      })),
      { count: 'exact' },
    )

    if (insertError) {
      result.failures.push({ subscriptionId: sub.id, reason: insertError.message })
      continue
    }

    result.subscriptionsExtended++
    result.occurrencesCreated += count ?? dates.length
  }

  return result
}

export type PromoteResult = {
  zonesConsidered: number
  promoted: number
  failures: Array<{ timezone: string; reason: string }>
}

/**
 * Moves scheduled occurrences to due_today once their day has arrived
 * where the service happens.
 *
 * Grouped by time zone rather than done row by row: every occurrence in
 * America/Chicago shares one answer to "what day is it", so this is one
 * update per zone instead of one per stop.
 *
 * Occurrences whose date has already passed are promoted too. A job that
 * missed a run should leave yesterday's uncompleted stops visible on the
 * route rather than stranding them in 'scheduled' forever.
 */
export async function promoteDueToday(args: { db: Db; now: Date }): Promise<PromoteResult> {
  const { db, now } = args
  const result: PromoteResult = { zonesConsidered: 0, promoted: 0, failures: [] }

  const { data: rows, error } = await db
    .from('service_occurrences')
    .select('local_timezone')
    .eq('state', 'scheduled')

  if (error) {
    result.failures.push({ timezone: '*', reason: `query failed: ${error.message}` })
    return result
  }

  const zones = [...new Set((rows ?? []).map((r) => r.local_timezone))]

  for (const tz of zones) {
    result.zonesConsidered++

    let todayIso: string
    try {
      todayIso = isoDate(civilDateIn(tz, now))
    } catch {
      // An unknown zone must not stall every other zone's route.
      result.failures.push({ timezone: tz, reason: 'unrecognised time zone' })
      continue
    }

    const { data: updated, error: updateError } = await db
      .from('service_occurrences')
      .update({ state: 'due_today' })
      .eq('state', 'scheduled')
      .eq('local_timezone', tz)
      .lte('service_date', todayIso)
      .select('id')

    if (updateError) {
      result.failures.push({ timezone: tz, reason: updateError.message })
      continue
    }

    result.promoted += (updated ?? []).length
  }

  return result
}

/**
 * Cancels future work when a subscription ends.
 *
 * Future occurrences become 'canceled', not skipped: nobody failed to
 * deliver, so nobody owes a credit. Anything already due_today or beyond is
 * left alone -- a stop the provider may already be standing in front of is
 * theirs to complete or skip, and deciding for them would either lose them
 * the earning or hand the customer a credit they are not owed.
 */
export async function cancelFutureOccurrences(args: {
  db: Db
  subscriptionId: string
}): Promise<{ canceled: number }> {
  const { data, error } = await args.db
    .from('service_occurrences')
    .update({ state: 'canceled' })
    .eq('subscription_id', args.subscriptionId)
    .eq('state', 'scheduled')
    .select('id')

  if (error) {
    console.error('[jobs] cancel future occurrences failed', error.message)
    return { canceled: 0 }
  }
  return { canceled: (data ?? []).length }
}
