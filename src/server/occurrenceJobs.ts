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
import { enqueueNotification } from '@/server/notifications'
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

/**
 * PostgREST returns an embedded to-one as an object or a one-element array
 * depending on how it inferred the relationship. Normalised here rather
 * than at each call site, the same way routeService does it.
 */
function one<T>(value: T | T[] | null | undefined): T | undefined {
  if (Array.isArray(value)) return value[0]
  return value ?? undefined
}

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

export type RemindResult = {
  zonesConsidered: number
  reminded: number
  failures: Array<{ timezone: string; reason: string }>
}

/**
 * "Your visit is tomorrow."
 *
 * PRD section 20 asks for occurrence.upcoming and nothing sent it. The
 * reminder matters most for the services where the customer has to do
 * something first -- keep the dog in, move the car off the drive, leave the
 * side gate unlocked -- and for the one where they might otherwise do the
 * job themselves before the provider arrives.
 *
 * ## Tomorrow in whose day?
 *
 * The same question promoteDueToday answers, and answered the same way:
 * grouped by IANA zone, with the civil date computed per zone. "Tomorrow"
 * at 11:00 UTC is a different date in Honolulu and in Boston, and a single
 * UTC comparison would send some customers a reminder for a visit two days
 * out and others one for a visit that already happened.
 *
 * Adding a day to the CIVIL date rather than to the instant is what makes
 * this survive daylight saving: the day after 1 November is 2 November
 * whether that day is 23, 24 or 25 hours long.
 *
 * ## Once, ever
 *
 * Keyed on the occurrence, so a run that fails halfway and repeats does not
 * send a second reminder, and a job that runs twice in a day sends nothing
 * the second time.
 *
 * Only 'scheduled' work is reminded about. Something already promoted,
 * completed, skipped or cancelled either happened or will not, and neither
 * needs a note about tomorrow.
 */
export async function remindUpcoming(args: { db: Db; now: Date }): Promise<RemindResult> {
  const { db, now } = args
  const result: RemindResult = { zonesConsidered: 0, reminded: 0, failures: [] }

  const { data: zoneRows, error } = await db
    .from('service_occurrences')
    .select('local_timezone')
    .eq('state', 'scheduled')

  if (error) {
    result.failures.push({ timezone: '*', reason: `query failed: ${error.message}` })
    return result
  }

  const zones = [...new Set((zoneRows ?? []).map((r) => r.local_timezone))]

  for (const tz of zones) {
    result.zonesConsidered++

    let tomorrowIso: string
    try {
      const today = civilDateIn(tz, now)
      tomorrowIso = isoDate(addDays(today, 1))
    } catch {
      // An unrecognised zone must not stall every other zone's reminders.
      result.failures.push({ timezone: tz, reason: 'unrecognised time zone' })
      continue
    }

    const { data: due, error: dueError } = await db
      .from('service_occurrences')
      .select(
        `id, service_date,
         subscriptions!inner (
           customer_user_id,
           provider_services!inner ( public_name )
         )`,
      )
      .eq('state', 'scheduled')
      .eq('local_timezone', tz)
      .eq('service_date', tomorrowIso)
      .limit(500)

    if (dueError) {
      result.failures.push({ timezone: tz, reason: dueError.message })
      continue
    }

    for (const row of due ?? []) {
      const sub = one<{ customer_user_id: string; provider_services: unknown }>(
        row.subscriptions as never,
      )
      if (!sub) continue
      const service = one<{ public_name: string }>(sub.provider_services as never)

      const { data: user } = await db
        .from('users')
        .select('email')
        .eq('id', sub.customer_user_id)
        .maybeSingle()

      if (!user?.email) continue

      const queued = await enqueueNotification({
        db,
        recipientUserId: sub.customer_user_id,
        now,
        idempotencyKey: `upcoming:${row.id}`,
        draft: {
          kind: 'occurrence.upcoming',
          channel: 'email',
          destination: user.email,
          subject: 'Your visit is tomorrow',
          // The service name is the provider's own public wording and is
          // safe on a lock screen. Nothing about the address, the access
          // code, or who is coming.
          preview: service?.public_name
            ? `${service.public_name} is scheduled for tomorrow.`
            : 'You have a visit scheduled for tomorrow.',
          payload: { occurrenceId: row.id },
        },
      })

      if (queued) result.reminded += 1
    }
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
