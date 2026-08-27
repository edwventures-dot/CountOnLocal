/**
 * Turning "how far will you walk" into a polygon.
 *
 * UX_UI_SPEC section 5: "Maps cannot be the only way to define/read a
 * service area." This is the other way. A provider gives a centre and a
 * distance, and the shape is computed -- no drawing surface, no mapping
 * library, and it works on a phone, with a keyboard, and read aloud.
 *
 * ## Why a circle rather than something drawn
 *
 * PRD section 5 wants tight service areas, and the growth mechanic is
 * filling a route before widening it. A fourteen-year-old pulling vertices
 * around a map produces a shape nobody can reason about, on a decision that
 * amounts to "how far am I willing to walk with a wheelie bin". A radius
 * says that directly.
 *
 * It also fails safe. A hand-drawn polygon can have a spur down one street
 * that the provider forgot about; a circle cannot surprise them.
 *
 * ## The centre is not the provider's house
 *
 * Callers are expected to pass a nearby landmark or a street corner, and
 * the UI says so. But this module cannot enforce that, so the safety comes
 * from elsewhere: the private geometry is never returned to an
 * unauthenticated caller, and the public storefront shows only a coarse
 * area LABEL -- a neighbourhood name -- rather than any geometry at all.
 *
 * Note what is deliberately absent: there is no generalized public polygon
 * produced here. A generalized circle still has a centre, and publishing
 * one centred near a minor's home narrows their location to a few streets
 * however coarse the edge is.
 */

/** Metres per degree of latitude. Close enough anywhere on Earth. */
const METRES_PER_DEGREE_LAT = 111_320

/** Tight by design. Two miles of walking is not a neighbourhood route. */
export const MIN_RADIUS_METRES = 100
export const MAX_RADIUS_METRES = 3_000
export const DEFAULT_RADIUS_METRES = 800

/** Points around the ring. Enough that the edge reads as a curve. */
const SEGMENTS = 48

export type GeoJsonPolygon = {
  type: 'Polygon'
  /** [[[lng, lat], ...]] -- longitude first, as GeoJSON requires. */
  coordinates: number[][][]
}

export function isRadiusAllowed(metres: number): boolean {
  return (
    Number.isFinite(metres) && metres >= MIN_RADIUS_METRES && metres <= MAX_RADIUS_METRES
  )
}

/**
 * A closed ring approximating a circle of `radiusMetres` around a point.
 *
 * Longitude degrees shrink as you move away from the equator, so the
 * east-west step is divided by cos(latitude). Skipping that gives an
 * ellipse that is too wide -- at Austin's latitude, about 18% too wide,
 * which would quietly put houses inside a route the provider never agreed
 * to serve.
 */
export function circlePolygon(args: {
  latitude: number
  longitude: number
  radiusMetres: number
}): GeoJsonPolygon {
  const { latitude, longitude, radiusMetres } = args

  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new RangeError('latitude must be between -90 and 90')
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new RangeError('longitude must be between -180 and 180')
  }
  if (!isRadiusAllowed(radiusMetres)) {
    throw new RangeError(
      `radiusMetres must be between ${MIN_RADIUS_METRES} and ${MAX_RADIUS_METRES}`,
    )
  }

  const latDelta = radiusMetres / METRES_PER_DEGREE_LAT
  // Guard the pole, where cos approaches zero and the division explodes.
  const cosLat = Math.max(Math.cos((latitude * Math.PI) / 180), 1e-6)
  const lngDelta = latDelta / cosLat

  const ring: number[][] = []
  for (let i = 0; i < SEGMENTS; i++) {
    const angle = (2 * Math.PI * i) / SEGMENTS
    ring.push([
      round6(longitude + lngDelta * Math.cos(angle)),
      round6(latitude + latDelta * Math.sin(angle)),
    ])
  }
  // GeoJSON rings close explicitly: the last point repeats the first.
  ring.push([ring[0]![0]!, ring[0]![1]!])

  return { type: 'Polygon', coordinates: [ring] }
}

/**
 * Six decimal places is about 11cm. More is noise, and fewer digits keeps
 * the stored geometry from being a precise fingerprint of a chosen point.
 */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6
}

/** Rounded to something a person would say out loud. */
export function describeRadius(metres: number): string {
  if (metres < 1000) return `${Math.round(metres / 50) * 50} m`
  return `${(Math.round(metres / 100) * 100) / 1000} km`
}
