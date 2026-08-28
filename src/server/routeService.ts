/**
 * The provider's Today route.
 *
 * PRD section 13 and UX_UI_SPEC section 12: the stops due, in order, with
 * today's expected earnings, an estimated length, per-stop instructions and
 * a completion count.
 *
 * ## Reading through the caller's own client
 *
 * This takes a user-scoped Supabase client, not the privileged one, and
 * that is the whole security design. Row level security decides which
 * addresses come back -- 0017 grants a provider exactly the addresses on
 * live subscriptions for their own business. If a future edit here selects
 * a column or joins a table it should not, the database refuses rather than
 * this file leaking a stranger's house.
 *
 * RLS alone is not sufficient here, though, and it is worth being precise
 * about why. occurrences_read_party grants read access to BOTH parties on a
 * subscription -- the customer needs to see their own visits too. So the
 * same row is legitimately visible to two people in two different roles,
 * and the database cannot tell which role the caller is acting in.
 *
 * Hence providerUserId: the filter states "this is a provider's route",
 * and RLS guarantees that whatever the filter says, no row from another
 * business can come back. Intent in the query, containment in the database.
 * Without the filter a customer calling this got their own visits back
 * dressed up as a route.
 *
 * ## Gate codes
 *
 * access_notes is returned, because a provider standing at a locked gate
 * needs the code. SAFETY_TRUST_POLICY section 14 governs everything after
 * that: it must never reach a log line, an email subject, a push preview or
 * an analytics payload. Nothing in this file logs the stop payload.
 */

import { ACTIONABLE_STATES, type OccurrenceState } from '@/domain/occurrence'
import {
  orderRoute,
  routeEarningsCents,
  routeProgress,
  type RouteStop,
  type TravelMode,
} from '@/domain/route'
import { describeDog, dogWarning } from '@/domain/serviceDetails'
import { isoDate } from '@/domain/schedule'
import { civilDateIn } from '@/server/occurrenceJobs'
import { parsePostgisPoint } from '@/lib/geo'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'

type Db = SupabaseClient<Database>

export type RouteStopView = {
  occurrenceId: string
  state: OccurrenceState
  /** Position in the route, 1-based. */
  position: number
  serviceDate: string
  windowStart: string | null
  windowEnd: string | null
  /** Provider's take for this stop, in cents. */
  valueCents: number
  address: {
    line1: string
    line2: string | null
    city: string
    region: string
    postalCode: string
    /** Gate codes and similar. Display only; never log this. */
    accessNotes: string | null
  } | null
  /** Customer's note for this visit, scope-limited at checkout. */
  instructions: string | null
  /** Dog on this stop, if the service involves one. */
  dog: string | null
  /** Shown as a warning rather than a detail. Bite history decides safety. */
  dogWarning: string | null
}

export type TodayRoute = {
  /** Local civil date the route is for. */
  date: string
  timezone: string
  stops: RouteStopView[]
  /** Provider earnings for the stops on this route, in cents. */
  expectedEarningsCents: number
  estimatedMetres: number
  estimatedMinutes: number
  progress: { done: number; total: number; complete: boolean }
  /** Stops whose address was never geocoded, so ordering could not place them. */
  unplacedCount: number
}

export type TodayRouteResult =
  | { ok: true; route: TodayRoute }
  | { ok: false; code: 'NO_BUSINESS' | 'QUERY_FAILED'; message: string }

/**
 * Today's route for the signed-in provider.
 *
 * `now` is injected rather than read from the clock so a route can be
 * rendered for a given instant and so tests are not clock-dependent.
 */
export async function getTodayRoute(args: {
  db: Db
  /** The signed-in provider. Establishes which role the caller is acting in. */
  providerUserId: string
  now: Date
  /** Defaults to the business's own zone; overridable for a preview. */
  timezone?: string | undefined
  travelMode?: TravelMode | undefined
  /** Provider's private start point. Never returned to a customer. */
  start?: { latitude: number; longitude: number } | undefined
}): Promise<TodayRouteResult> {
  const { db, now } = args

  // Occurrences the caller can see at all. RLS has already restricted this
  // to subscriptions on their own business.
  const { data, error } = await db
    .from('service_occurrences')
    .select(
      `id, state, service_date, local_timezone,
       service_window_start, service_window_end, service_value_cents,
       subscriptions!inner (
         customer_instructions,
         service_details,
         customer_addresses!inner (
           line1, line2, city, region, postal_code, access_notes, point
         ),
         provider_services!inner (
           businesses!inner ( provider_user_id )
         )
       )`,
    )
    .eq('subscriptions.provider_services.businesses.provider_user_id', args.providerUserId)
    .in('state', [...ACTIONABLE_STATES, 'completed'])

  if (error) {
    console.error('[route] query failed', error.message)
    return { ok: false, code: 'QUERY_FAILED', message: 'Could not load your route.' }
  }

  const rows = data ?? []
  if (rows.length === 0) {
    const tz = args.timezone ?? 'UTC'
    return {
      ok: true,
      route: {
        date: isoDate(civilDateIn(tz, now)),
        timezone: tz,
        stops: [],
        expectedEarningsCents: 0,
        estimatedMetres: 0,
        estimatedMinutes: 0,
        progress: { done: 0, total: 0, complete: false },
        unplacedCount: 0,
      },
    }
  }

  // The zone comes off the occurrences themselves. A provider running two
  // services in different zones is legal; the first row's zone decides
  // which "today" this route is for, and the filter below keeps the route
  // internally consistent.
  const timezone = args.timezone ?? rows[0]!.local_timezone
  const today = isoDate(civilDateIn(timezone, now))

  type Row = (typeof rows)[number]
  const one = <T,>(v: T | T[] | null | undefined): T | undefined =>
    Array.isArray(v) ? v[0] : (v ?? undefined)

  const forToday = rows.filter((r) => r.service_date === today && r.local_timezone === timezone)

  const stopInputs: RouteStop[] = forToday.map((r) => {
    const sub = one<{ customer_addresses: unknown }>(r.subscriptions as never)
    const addr = one<{ point: unknown }>(sub?.customer_addresses as never)
    const point = parsePostgisPoint(addr?.point)
    return {
      occurrenceId: r.id,
      point,
      ...(r.service_window_start ? { windowStart: r.service_window_start } : {}),
    }
  })

  const ordered = orderRoute({
    stops: stopInputs,
    ...(args.start ? { start: args.start } : {}),
    ...(args.travelMode ? { travelMode: args.travelMode } : {}),
  })

  const byId = new Map<string, Row>(forToday.map((r) => [r.id, r]))

  const stops: RouteStopView[] = ordered.order.map((id, i) => {
    const r = byId.get(id)!
    const sub = one<{
      customer_instructions: string | null
      service_details: unknown
      customer_addresses: unknown
    }>(
      r.subscriptions as never,
    )
    const addr = one<{
      line1: string
      line2: string | null
      city: string
      region: string
      postal_code: string
      access_notes: string | null
    }>(sub?.customer_addresses as never)

    return {
      occurrenceId: r.id,
      state: r.state as OccurrenceState,
      position: i + 1,
      serviceDate: r.service_date,
      windowStart: r.service_window_start,
      windowEnd: r.service_window_end,
      valueCents: r.service_value_cents,
      address: addr
        ? {
            line1: addr.line1,
            line2: addr.line2,
            city: addr.city,
            region: addr.region,
            postalCode: addr.postal_code,
            accessNotes: addr.access_notes,
          }
        : null,
      instructions: sub?.customer_instructions ?? null,
      // Structured, not folded into the instructions text. A provider
      // skimming a paragraph on a phone will not reliably notice the
      // sentence that says the dog has bitten somebody.
      dog: describeDog(sub?.service_details as never) ?? null,
      dogWarning: dogWarning(sub?.service_details as never) ?? null,
    }
  })

  const completed = stops.filter((s) => s.state === 'completed').length

  return {
    ok: true,
    route: {
      date: today,
      timezone,
      stops,
      // Earnings for the whole route, delivered or not: this is what the
      // day is worth, which is what UX_UI_SPEC section 12 puts on the card.
      expectedEarningsCents: routeEarningsCents(stops.map((s) => s.valueCents)),
      estimatedMetres: ordered.estimatedMetres,
      estimatedMinutes: ordered.estimatedMinutes,
      progress: routeProgress({ total: stops.length, completed }),
      unplacedCount: ordered.unplaced.length,
    },
  }
}
