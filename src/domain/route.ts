/**
 * Ordering a day's stops.
 *
 * TECHNICAL_SPEC section 13 wants ordered occurrence ids, an estimated
 * distance and time, and a revision timestamp, computed from stop
 * coordinates, an optional provider start point, a duration estimate and
 * the service windows.
 *
 * ## Why nearest-neighbour and not something better
 *
 * Optimal routing is NP-hard and the honest V1 answer is that it does not
 * matter here. A dense neighbourhood route is eight to thirty stops within
 * a few streets, walked or biked by one person. Nearest-neighbour on that
 * shape lands within a few percent of optimal, runs instantly, needs no
 * vendor, and -- the part that matters for a product a fourteen-year-old
 * uses -- produces an order a human can look at and understand.
 *
 * If routes ever get long enough for this to cost real time, the thing to
 * do is call a real routing service, not to hand-roll 2-opt here.
 *
 * ## Distances are straight lines
 *
 * Haversine, not street distance. It is honest about being an estimate and
 * it needs no network call. On a neighbourhood route the error is small and
 * uniform, so the ORDER it produces is essentially the same as a street-
 * aware one would give. The distance figure is labelled an estimate
 * wherever it is shown for that reason.
 *
 * Everything here is pure and deterministic: ties break on occurrence id,
 * so the same stops always produce the same route.
 */

export type Coordinate = { latitude: number; longitude: number }

export type RouteStop = {
  occurrenceId: string
  /** Null when an address was never geocoded. Kept, but ordered last. */
  point: Coordinate | null
  /** Local "HH:MM". Only used to break ties, never to reorder around. */
  windowStart?: string | undefined
}

export type OrderedRoute = {
  /** Occurrence ids, in the order they should be visited. */
  order: string[]
  /** Straight-line total, metres. An estimate; label it as one. */
  estimatedMetres: number
  /** Rough minutes, including a per-stop service allowance. */
  estimatedMinutes: number
  /** Stops that could not be placed because they have no coordinates. */
  unplaced: string[]
}

const EARTH_RADIUS_M = 6_371_000

/** Great-circle distance in metres. */
export function haversineMetres(a: Coordinate, b: Coordinate): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b.latitude - a.latitude)
  const dLon = toRad(b.longitude - a.longitude)
  const lat1 = toRad(a.latitude)
  const lat2 = toRad(b.latitude)

  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2)
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

export type TravelMode = 'walking' | 'cycling' | 'driving'

/** Rough metres per minute. Deliberately conservative for a loaded route. */
export const TRAVEL_SPEED_M_PER_MIN: Readonly<Record<TravelMode, number>> = {
  walking: 70,
  cycling: 200,
  driving: 400,
}

/**
 * Orders stops nearest-neighbour from an optional start point.
 *
 * Without a start point the route begins at the stop with the earliest
 * service window, and failing that the lowest id -- deterministic either
 * way, because a route that reshuffles itself between two page loads looks
 * broken even when the total distance is identical.
 *
 * Stops with no coordinates are appended in a stable order rather than
 * dropped. An ungeocoded address is still a house someone is expecting.
 */
export function orderRoute(args: {
  stops: readonly RouteStop[]
  start?: Coordinate | undefined
  travelMode?: TravelMode | undefined
  /** Minutes allowed per stop, for the time estimate. */
  minutesPerStop?: number | undefined
}): OrderedRoute {
  const travelMode = args.travelMode ?? 'walking'
  const minutesPerStop = args.minutesPerStop ?? 4

  const placed = args.stops.filter((s): s is RouteStop & { point: Coordinate } => s.point !== null)
  const unplaced = args.stops
    .filter((s) => s.point === null)
    .map((s) => s.occurrenceId)
    .sort()

  if (placed.length === 0) {
    return { order: unplaced, estimatedMetres: 0, estimatedMinutes: 0, unplaced }
  }

  // Deterministic seed: earliest window, then id.
  const sorted = [...placed].sort((a, b) => {
    const aw = a.windowStart ?? ''
    const bw = b.windowStart ?? ''
    if (aw !== bw) return aw < bw ? -1 : 1
    return a.occurrenceId < b.occurrenceId ? -1 : 1
  })

  const remaining = new Map(sorted.map((s) => [s.occurrenceId, s]))
  const order: string[] = []
  let metres = 0

  let cursor: Coordinate
  if (args.start) {
    cursor = args.start
  } else {
    const first = sorted[0]!
    order.push(first.occurrenceId)
    remaining.delete(first.occurrenceId)
    cursor = first.point
  }

  while (remaining.size > 0) {
    let bestId = ''
    let bestDistance = Number.POSITIVE_INFINITY

    for (const [id, stop] of remaining) {
      const d = haversineMetres(cursor, stop.point)
      // Strict less-than, and the map preserves the deterministic seed
      // order, so an exact tie keeps the earlier-window stop.
      if (d < bestDistance) {
        bestDistance = d
        bestId = id
      }
    }

    const chosen = remaining.get(bestId)!
    order.push(bestId)
    remaining.delete(bestId)
    metres += bestDistance
    cursor = chosen.point
  }

  const travelMinutes = metres / TRAVEL_SPEED_M_PER_MIN[travelMode]
  const estimatedMinutes = Math.round(travelMinutes + placed.length * minutesPerStop)

  return {
    order: [...order, ...unplaced],
    estimatedMetres: Math.round(metres),
    estimatedMinutes,
    unplaced,
  }
}

/**
 * Today's earnings for a route.
 *
 * The provider's service value only. The platform fee is the customer's
 * side of the transaction and showing it here would misstate what the
 * provider takes home -- PRD section 13 is explicit that Money means
 * provider earnings, and warns against the word "profit" while costs are
 * not tracked.
 */
export function routeEarningsCents(stopValues: readonly number[]): number {
  return stopValues.reduce((a, v) => a + v, 0)
}

export type RouteProgress = { done: number; total: number; complete: boolean }

/** "12 of 18 done", for the progress line in UX_UI_SPEC section 12. */
export function routeProgress(args: {
  total: number
  completed: number
}): RouteProgress {
  const done = Math.min(args.completed, args.total)
  return { done, total: args.total, complete: args.total > 0 && done >= args.total }
}
