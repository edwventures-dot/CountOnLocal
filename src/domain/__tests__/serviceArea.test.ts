import { describe, expect, it } from 'vitest'
import {
  circlePolygon,
  describeRadius,
  isRadiusAllowed,
  MAX_RADIUS_METRES,
  MIN_RADIUS_METRES,
} from '../serviceArea'

/** Austin, roughly. Latitude 30 is far enough north to matter. */
const AUSTIN = { latitude: 30.2672, longitude: -97.7431 }

/** Metres between two points, by haversine, for checking the ring. */
function metresBetween(a: [number, number], b: [number, number]): number {
  const R = 6_371_000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b[0] - a[0])
  const dLng = toRad(b[1] - a[1])
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}

describe('the ring is actually the radius asked for', () => {
  it('puts every point within a couple of metres of the radius', () => {
    const poly = circlePolygon({ ...AUSTIN, radiusMetres: 800 })
    const ring = poly.coordinates[0]!

    for (const [lng, lat] of ring) {
      const d = metresBetween([AUSTIN.latitude, AUSTIN.longitude], [lat!, lng!])
      // Rounding to six decimals costs a few centimetres; the spherical
      // approximation costs a little more. Two metres in 800 is fine for
      // deciding whether a house is on a walking route.
      expect(Math.abs(d - 800)).toBeLessThan(3)
    }
  })

  it('corrects for longitude shrinking away from the equator', () => {
    // Without dividing by cos(lat) the shape is an ellipse that is too
    // wide -- at this latitude about 18% too wide, which would put houses
    // inside a route the provider never agreed to serve.
    const poly = circlePolygon({ ...AUSTIN, radiusMetres: 1000 })
    const ring = poly.coordinates[0]!

    const east = ring[0]! // angle 0
    const north = ring[Math.floor(ring.length / 4)]! // angle pi/2

    const eastMetres = metresBetween(
      [AUSTIN.latitude, AUSTIN.longitude],
      [east[1]!, east[0]!],
    )
    const northMetres = metresBetween(
      [AUSTIN.latitude, AUSTIN.longitude],
      [north[1]!, north[0]!],
    )

    expect(Math.abs(eastMetres - northMetres)).toBeLessThan(3)
  })

  it('holds at the equator too', () => {
    const poly = circlePolygon({ latitude: 0, longitude: 0, radiusMetres: 500 })
    for (const [lng, lat] of poly.coordinates[0]!) {
      expect(Math.abs(metresBetween([0, 0], [lat!, lng!]) - 500)).toBeLessThan(3)
    }
  })

  it('does not blow up near a pole', () => {
    // cos(latitude) approaches zero there and an unguarded division would
    // produce Infinity.
    const poly = circlePolygon({ latitude: 89.999, longitude: 0, radiusMetres: 500 })
    for (const [lng, lat] of poly.coordinates[0]!) {
      expect(Number.isFinite(lng)).toBe(true)
      expect(Number.isFinite(lat)).toBe(true)
    }
  })
})

describe('the polygon is valid GeoJSON', () => {
  it('closes the ring', () => {
    const ring = circlePolygon({ ...AUSTIN, radiusMetres: 800 }).coordinates[0]!
    expect(ring[0]).toEqual(ring[ring.length - 1])
  })

  it('puts longitude first', () => {
    // The single most common way to get PostGIS silently wrong.
    const ring = circlePolygon({ ...AUSTIN, radiusMetres: 800 }).coordinates[0]!
    for (const [lng, lat] of ring) {
      expect(lng!).toBeLessThan(0) // Austin is west of Greenwich
      expect(lat!).toBeGreaterThan(0) // and north of the equator
    }
  })

  it('is typed as a Polygon', () => {
    expect(circlePolygon({ ...AUSTIN, radiusMetres: 800 }).type).toBe('Polygon')
  })
})

describe('the radius is kept tight', () => {
  it('accepts the documented range', () => {
    expect(isRadiusAllowed(MIN_RADIUS_METRES)).toBe(true)
    expect(isRadiusAllowed(MAX_RADIUS_METRES)).toBe(true)
    expect(isRadiusAllowed(800)).toBe(true)
  })

  it('refuses a route nobody is walking', () => {
    // PRD section 5 makes tight areas the point: fill a route before
    // widening it.
    expect(isRadiusAllowed(MAX_RADIUS_METRES + 1)).toBe(false)
    expect(isRadiusAllowed(50_000)).toBe(false)
  })

  it('refuses a degenerate one', () => {
    expect(isRadiusAllowed(0)).toBe(false)
    expect(isRadiusAllowed(-100)).toBe(false)
    expect(isRadiusAllowed(Number.NaN)).toBe(false)
  })

  it('throws rather than silently clamping', () => {
    expect(() => circlePolygon({ ...AUSTIN, radiusMetres: 100_000 })).toThrow(RangeError)
    expect(() => circlePolygon({ ...AUSTIN, radiusMetres: 0 })).toThrow(RangeError)
  })

  it('refuses coordinates that are not on Earth', () => {
    expect(() => circlePolygon({ latitude: 91, longitude: 0, radiusMetres: 800 })).toThrow()
    expect(() => circlePolygon({ latitude: 0, longitude: 181, radiusMetres: 800 })).toThrow()
  })
})

describe('describing it', () => {
  it('speaks in metres under a kilometre', () => {
    expect(describeRadius(800)).toBe('800 m')
    expect(describeRadius(430)).toBe('450 m')
  })

  it('switches to kilometres above that', () => {
    expect(describeRadius(1500)).toBe('1.5 km')
    expect(describeRadius(3000)).toBe('3 km')
  })
})
