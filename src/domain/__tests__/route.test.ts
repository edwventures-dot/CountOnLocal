import { describe, expect, it } from 'vitest'
import {
  haversineMetres,
  orderRoute,
  routeEarningsCents,
  routeProgress,
  TRAVEL_SPEED_M_PER_MIN,
  type RouteStop,
} from '../route'

/** Four houses along one street, roughly 100 m apart, listed out of order. */
const OAK: RouteStop[] = [
  { occurrenceId: 'c', point: { latitude: 30.2700, longitude: -97.7400 } },
  { occurrenceId: 'a', point: { latitude: 30.2682, longitude: -97.7400 } },
  { occurrenceId: 'd', point: { latitude: 30.2709, longitude: -97.7400 } },
  { occurrenceId: 'b', point: { latitude: 30.2691, longitude: -97.7400 } },
]

describe('haversineMetres', () => {
  it('is zero for the same point', () => {
    const p = { latitude: 30.27, longitude: -97.74 }
    expect(haversineMetres(p, p)).toBe(0)
  })

  it('is symmetric', () => {
    const a = { latitude: 30.27, longitude: -97.74 }
    const b = { latitude: 30.28, longitude: -97.75 }
    expect(haversineMetres(a, b)).toBeCloseTo(haversineMetres(b, a), 6)
  })

  it('gets a known distance about right', () => {
    // One degree of latitude is close to 111 km anywhere on Earth.
    const d = haversineMetres(
      { latitude: 30, longitude: -97 },
      { latitude: 31, longitude: -97 },
    )
    expect(d).toBeGreaterThan(110_000)
    expect(d).toBeLessThan(112_000)
  })
})

describe('ordering a street', () => {
  it('walks the houses in order rather than zig-zagging', () => {
    const route = orderRoute({
      stops: OAK,
      start: { latitude: 30.2680, longitude: -97.7400 },
    })
    expect(route.order).toEqual(['a', 'b', 'c', 'd'])
  })

  it('walks the other way when started from the other end', () => {
    const route = orderRoute({
      stops: OAK,
      start: { latitude: 30.2715, longitude: -97.7400 },
    })
    expect(route.order).toEqual(['d', 'c', 'b', 'a'])
  })

  it('visits every stop exactly once', () => {
    const route = orderRoute({ stops: OAK })
    expect([...route.order].sort()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('is deterministic -- the same stops give the same route twice', () => {
    const a = orderRoute({ stops: OAK })
    const b = orderRoute({ stops: [...OAK].reverse() })
    expect(a.order).toEqual(b.order)
  })

  it('beats the order the stops arrived in', () => {
    const naive = OAK.reduce((total, stop, i) => {
      const prev = OAK[i - 1]
      return i === 0 ? total : total + haversineMetres(prev!.point!, stop.point!)
    }, 0)
    const routed = orderRoute({ stops: OAK }).estimatedMetres
    expect(routed).toBeLessThan(naive)
  })
})

describe('stops without coordinates', () => {
  it('keeps them rather than dropping a house someone is expecting', () => {
    const route = orderRoute({
      stops: [...OAK, { occurrenceId: 'z', point: null }],
    })
    expect(route.order).toContain('z')
    expect(route.order).toHaveLength(5)
  })

  it('puts them at the end and names them', () => {
    const route = orderRoute({
      stops: [{ occurrenceId: 'z', point: null }, ...OAK],
    })
    expect(route.order[route.order.length - 1]).toBe('z')
    expect(route.unplaced).toEqual(['z'])
  })

  it('handles a route where nothing is geocoded', () => {
    const route = orderRoute({
      stops: [
        { occurrenceId: 'y', point: null },
        { occurrenceId: 'x', point: null },
      ],
    })
    expect(route.order).toEqual(['x', 'y'])
    expect(route.estimatedMetres).toBe(0)
  })
})

describe('estimates', () => {
  it('is zero distance for a single stop', () => {
    const route = orderRoute({ stops: [OAK[0]!] })
    expect(route.estimatedMetres).toBe(0)
  })

  it('still allows service time for a single stop', () => {
    const route = orderRoute({ stops: [OAK[0]!], minutesPerStop: 5 })
    expect(route.estimatedMinutes).toBe(5)
  })

  it('takes less time by bike than on foot over the same route', () => {
    const walking = orderRoute({ stops: OAK, travelMode: 'walking' })
    const cycling = orderRoute({ stops: OAK, travelMode: 'cycling' })
    expect(cycling.estimatedMinutes).toBeLessThan(walking.estimatedMinutes)
    expect(cycling.estimatedMetres).toBe(walking.estimatedMetres)
  })

  it('has sane speeds -- walking slower than cycling slower than driving', () => {
    expect(TRAVEL_SPEED_M_PER_MIN.walking).toBeLessThan(TRAVEL_SPEED_M_PER_MIN.cycling)
    expect(TRAVEL_SPEED_M_PER_MIN.cycling).toBeLessThan(TRAVEL_SPEED_M_PER_MIN.driving)
  })

  it('scales the per-stop allowance with the number of stops', () => {
    const two = orderRoute({ stops: OAK.slice(0, 2), minutesPerStop: 10 })
    const four = orderRoute({ stops: OAK, minutesPerStop: 10 })
    expect(four.estimatedMinutes - two.estimatedMinutes).toBeGreaterThanOrEqual(20)
  })
})

describe('service windows break ties, they do not reorder', () => {
  it('seeds from the earliest window when there is no start point', () => {
    const route = orderRoute({
      stops: [
        { occurrenceId: 'late', point: { latitude: 30.2700, longitude: -97.74 }, windowStart: '14:00' },
        { occurrenceId: 'early', point: { latitude: 30.2709, longitude: -97.74 }, windowStart: '08:00' },
      ],
    })
    expect(route.order[0]).toBe('early')
  })
})

describe('an empty day', () => {
  it('returns an empty route rather than throwing', () => {
    const route = orderRoute({ stops: [] })
    expect(route).toEqual({ order: [], estimatedMetres: 0, estimatedMinutes: 0, unplaced: [] })
  })
})

describe('routeEarningsCents', () => {
  it('sums the provider service value', () => {
    // 18 stops at $3 = $54, the figure in UX_UI_SPEC section 12.
    expect(routeEarningsCents(Array(18).fill(300))).toBe(5400)
  })

  it('is zero for an empty route', () => {
    expect(routeEarningsCents([])).toBe(0)
  })
})

describe('routeProgress', () => {
  it('reads as "12 of 18"', () => {
    expect(routeProgress({ total: 18, completed: 12 })).toEqual({
      done: 12,
      total: 18,
      complete: false,
    })
  })

  it('is complete at the end', () => {
    expect(routeProgress({ total: 18, completed: 18 }).complete).toBe(true)
  })

  it('does not report more done than exist', () => {
    expect(routeProgress({ total: 3, completed: 9 }).done).toBe(3)
  })

  it('is not complete on an empty day', () => {
    // Nothing scheduled is not an achievement.
    expect(routeProgress({ total: 0, completed: 0 }).complete).toBe(false)
  })
})
