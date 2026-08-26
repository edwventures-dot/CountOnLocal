import { describe, expect, it } from 'vitest'
import { parsePostgisPoint, fromEwkbHex } from '../geo'

/**
 * Taken from the live database: the point written for latitude 30.27,
 * longitude -97.74 by set_customer_address_point.
 */
const REAL = '0101000020E61000008FC2F5285C6F58C085EB51B81E453E40'

describe('EWKB hex from PostgREST', () => {
  it('reads a real point written by the database', () => {
    const p = fromEwkbHex(REAL)
    expect(p).not.toBeNull()
    expect(p!.latitude).toBeCloseTo(30.27, 6)
    expect(p!.longitude).toBeCloseTo(-97.74, 6)
  })

  it('does not transpose latitude and longitude', () => {
    // The failure mode this module exists to prevent: Austin is at
    // 30 N, 97 W. Swapped, it would be off the coast of Somalia.
    const p = fromEwkbHex(REAL)!
    expect(p.latitude).toBeGreaterThan(0)
    expect(p.longitude).toBeLessThan(0)
  })

  it('accepts a point with no SRID', () => {
    // 21-byte form: 01, type 1, then X and Y.
    const noSrid = '0101000000' + '8FC2F5285C6F58C0' + '85EB51B81E453E40'
    const p = fromEwkbHex(noSrid)
    expect(p!.latitude).toBeCloseTo(30.27, 6)
  })

  it('rejects a truncated string', () => {
    expect(fromEwkbHex(REAL.slice(0, 30))).toBeNull()
  })

  it('rejects non-hex', () => {
    expect(fromEwkbHex('zzzz000020E6100000' + '0'.repeat(32))).toBeNull()
  })

  it('rejects a geometry that is not a point', () => {
    // Type 2 is LineString.
    const line = '0102000020E6100000' + '8FC2F5285C6F58C0' + '85EB51B81E453E40'
    expect(fromEwkbHex(line)).toBeNull()
  })

  it('tolerates surrounding whitespace', () => {
    expect(fromEwkbHex(`  ${REAL}  `)).not.toBeNull()
  })
})

describe('parsePostgisPoint', () => {
  it('handles the hex form', () => {
    expect(parsePostgisPoint(REAL)!.latitude).toBeCloseTo(30.27, 6)
  })

  it('handles GeoJSON, in case a future config returns it', () => {
    const p = parsePostgisPoint({ type: 'Point', coordinates: [-97.74, 30.27] })
    expect(p!.latitude).toBeCloseTo(30.27, 6)
    expect(p!.longitude).toBeCloseTo(-97.74, 6)
  })

  it('returns null for null, so an ungeocoded stop just orders last', () => {
    expect(parsePostgisPoint(null)).toBeNull()
    expect(parsePostgisPoint(undefined)).toBeNull()
  })

  it('returns null for a number or a boolean', () => {
    expect(parsePostgisPoint(42)).toBeNull()
    expect(parsePostgisPoint(true)).toBeNull()
  })

  it('rejects a GeoJSON polygon', () => {
    expect(parsePostgisPoint({ type: 'Polygon', coordinates: [[[0, 0]]] })).toBeNull()
  })
})

describe('range guards', () => {
  it('rejects an impossible latitude', () => {
    expect(parsePostgisPoint({ type: 'Point', coordinates: [0, 91] })).toBeNull()
  })

  it('rejects an impossible longitude', () => {
    expect(parsePostgisPoint({ type: 'Point', coordinates: [181, 0] })).toBeNull()
  })

  it('accepts the poles and the antimeridian', () => {
    expect(parsePostgisPoint({ type: 'Point', coordinates: [180, 90] })).toEqual({
      latitude: 90,
      longitude: 180,
    })
  })

  it('accepts null island rather than treating zero as missing', () => {
    expect(parsePostgisPoint({ type: 'Point', coordinates: [0, 0] })).toEqual({
      latitude: 0,
      longitude: 0,
    })
  })
})
