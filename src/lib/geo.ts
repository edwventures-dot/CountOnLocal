/**
 * Reading a PostGIS point back out of PostgREST.
 *
 * A geography column does not come back as GeoJSON. PostgREST serialises it
 * as EWKB hex, which looks like this:
 *
 *   0101000020E61000008FC2F5285C6F58C085EB51B81E453E40
 *   ^^                                                  byte order, 01 = little
 *     ^^^^^^^^                                          type: 1 (Point) | 0x20000000 (has SRID)
 *             ^^^^^^^^                                  SRID, E6100000 = 4326
 *                     ^^^^^^^^^^^^^^^^                  X, a float64 -- longitude
 *                                     ^^^^^^^^^^^^^^^^  Y -- latitude
 *
 * The X/Y order is the part worth writing down. PostGIS stores longitude
 * first and everything human-facing says "latitude, longitude", so a
 * transposition here puts a house in the wrong hemisphere and still looks
 * like a plausible coordinate. That is why this is its own module with its
 * own tests rather than an inline helper.
 *
 * Anything unrecognised returns null. A stop whose address cannot be placed
 * is ordered last, which is a worse route -- not a broken one.
 */

export type LatLng = { latitude: number; longitude: number }

const POINT_TYPE = 1
const SRID_FLAG = 0x20000000

/**
 * Parses whatever PostgREST hands back for a geography(Point) column.
 *
 * Accepts EWKB hex, and GeoJSON in case a future PostgREST config returns
 * it. Returns null rather than throwing: an unparseable point is a routing
 * inconvenience, not a request failure.
 */
export function parsePostgisPoint(raw: unknown): LatLng | null {
  if (raw == null) return null

  if (typeof raw === 'object') return fromGeoJson(raw)
  if (typeof raw === 'string') return fromEwkbHex(raw)
  return null
}

function fromGeoJson(raw: object): LatLng | null {
  const g = raw as { type?: unknown; coordinates?: unknown }
  if (g.type !== 'Point' || !Array.isArray(g.coordinates)) return null
  const [lon, lat] = g.coordinates as unknown[]
  if (typeof lat !== 'number' || typeof lon !== 'number') return null
  return inRange(lat, lon)
}

export function fromEwkbHex(hex: string): LatLng | null {
  const clean = hex.trim()
  // Point with SRID is 25 bytes: 1 + 4 + 4 + 8 + 8. Without SRID, 21.
  if (clean.length !== 50 && clean.length !== 42) return null
  if (!/^[0-9a-fA-F]+$/.test(clean)) return null

  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }

  const view = new DataView(bytes.buffer)
  const order = bytes[0]
  // 00 is big-endian, 01 little. PostGIS emits little on every platform
  // this runs on, but honouring the flag costs one boolean.
  if (order !== 0 && order !== 1) return null
  const little = order === 1

  const typeField = view.getUint32(1, little)
  const hasSrid = (typeField & SRID_FLAG) !== 0
  const geometryType = typeField & 0xff

  if (geometryType !== POINT_TYPE) return null

  const coordsAt = hasSrid ? 9 : 5
  if (bytes.length < coordsAt + 16) return null

  // X then Y. Longitude then latitude.
  const longitude = view.getFloat64(coordsAt, little)
  const latitude = view.getFloat64(coordsAt + 8, little)

  return inRange(latitude, longitude)
}

/**
 * A last guard against a transposed pair. Latitude beyond ±90 is
 * impossible, so a swapped coordinate outside the tropics is caught here
 * rather than silently routing someone across an ocean.
 */
function inRange(latitude: number, longitude: number): LatLng | null {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
  if (latitude < -90 || latitude > 90) return null
  if (longitude < -180 || longitude > 180) return null
  return { latitude, longitude }
}
