import { describe, expect, it } from 'vitest'
import { ERROR_CORRECTION, QUIET_ZONE_MODULES, qrModules, qrSvgDataUri } from '@/server/qr'

const URL = 'https://countonlocal.com/jakes-bin-service?ref=ABCD2345'

/**
 * The canonical QR finder pattern: a 7x7 square with a 5x5 white ring and a
 * 3x3 dark core. Three of these, one at each corner except bottom-right, is
 * what a reader looks for to locate and orient the symbol.
 *
 * Checking these is the strongest structural claim available without a
 * scanner in the loop. A symbol missing them is not a QR code at all.
 */
const FINDER = [
  '#######',
  '#.....#',
  '#.###.#',
  '#.###.#',
  '#.###.#',
  '#.....#',
  '#######',
]

function patternAt(modules: boolean[][], top: number, left: number): string[] {
  return Array.from({ length: 7 }, (_, r) =>
    Array.from({ length: 7 }, (_, c) => (modules[top + r]![left + c] ? '#' : '.')).join(''),
  )
}

describe('the symbol is structurally a QR code', () => {
  const modules = qrModules(URL)
  const size = modules.length

  it('is square', () => {
    expect(modules.every((row) => row.length === size)).toBe(true)
  })

  it('has a version-appropriate size', () => {
    // Sizes are 21 + 4*(version-1), so always 21, 25, 29, ... and odd.
    expect((size - 21) % 4).toBe(0)
    expect(size).toBeGreaterThanOrEqual(21)
  })

  it('has a finder pattern top-left', () => {
    expect(patternAt(modules, 0, 0)).toEqual(FINDER)
  })

  it('has a finder pattern top-right', () => {
    expect(patternAt(modules, 0, size - 7)).toEqual(FINDER)
  })

  it('has a finder pattern bottom-left', () => {
    expect(patternAt(modules, size - 7, 0)).toEqual(FINDER)
  })

  it('has no finder pattern bottom-right, which is how orientation works', () => {
    expect(patternAt(modules, size - 7, size - 7)).not.toEqual(FINDER)
  })

  it('has the alternating timing pattern on row 6', () => {
    // Between the finders, row 6 alternates dark/light starting dark.
    for (let c = 8; c < size - 8; c++) {
      expect(modules[6]![c]).toBe(c % 2 === 0)
    }
  })

  it('has the alternating timing pattern on column 6', () => {
    for (let r = 8; r < size - 8; r++) {
      expect(modules[r]![6]).toBe(r % 2 === 0)
    }
  })

  it('carries actual data rather than an empty grid', () => {
    const dark = modules.flat().filter(Boolean).length
    const total = size * size
    // A real symbol lands near half dark. Anything far outside that means
    // the encoder produced something degenerate.
    expect(dark / total).toBeGreaterThan(0.25)
    expect(dark / total).toBeLessThan(0.75)
  })
})

describe('different content produces a different symbol', () => {
  it('changes when the referral code changes', () => {
    const a = qrModules('https://countonlocal.com/x?ref=AAAA2345')
    const b = qrModules('https://countonlocal.com/x?ref=BBBB2345')
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b))
  })

  it('is deterministic for the same content', () => {
    expect(JSON.stringify(qrModules(URL))).toBe(JSON.stringify(qrModules(URL)))
  })

  it('grows with longer content', () => {
    const short = qrModules('https://countonlocal.com/a')
    const long = qrModules('https://countonlocal.com/' + 'a'.repeat(200))
    expect(long.length).toBeGreaterThan(short.length)
  })
})

describe('the data URI', () => {
  it('is an SVG, because flyers are printed', async () => {
    const r = await qrSvgDataUri(URL)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.dataUri.startsWith('data:image/svg+xml;base64,')).toBe(true)
  })

  it('decodes back to real SVG markup', async () => {
    const r = await qrSvgDataUri(URL)
    if (!r.ok) return
    const svg = Buffer.from(r.dataUri.split(',')[1]!, 'base64').toString('utf8')
    expect(svg).toContain('<svg')
    expect(svg).toContain('viewBox')
  })

  it('uses ink on white, not brand lime, because a reader needs contrast', async () => {
    const r = await qrSvgDataUri(URL)
    if (!r.ok) return
    const svg = Buffer.from(r.dataUri.split(',')[1]!, 'base64').toString('utf8')
    expect(svg).toContain('#14263A')
    expect(svg).not.toContain('C7F34A')
  })

  it('reports the version and module count', async () => {
    const r = await qrSvgDataUri(URL)
    if (r.ok) {
      expect(r.version).toBeGreaterThan(0)
      expect(r.moduleCount).toBe(qrModules(URL).length)
    }
  })

  it('refuses empty content rather than encoding nothing', async () => {
    const r = await qrSvgDataUri('   ')
    expect(r.ok).toBe(false)
  })

  it('fails rather than throws, so a flyer still prints', async () => {
    // Beyond what any QR version can hold.
    const r = await qrSvgDataUri('x'.repeat(10_000))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(typeof r.message).toBe('string')
  })
})

describe('print settings', () => {
  it('uses 25% error correction, for paper left outdoors', () => {
    expect(ERROR_CORRECTION).toBe('Q')
  })

  it('keeps the four-module quiet zone the spec requires', () => {
    // Skipping this is the classic reason a printed code will not scan: a
    // reader needs the blank border to find the symbol against the paper.
    expect(QUIET_ZONE_MODULES).toBeGreaterThanOrEqual(4)
  })

  it('actually emits the quiet zone in the SVG viewBox', async () => {
    const r = await qrSvgDataUri(URL)
    if (!r.ok) return
    const svg = Buffer.from(r.dataUri.split(',')[1]!, 'base64').toString('utf8')
    const viewBox = /viewBox="0 0 (\d+) (\d+)"/.exec(svg)
    expect(viewBox).not.toBeNull()
    // Symbol plus a margin on both sides.
    expect(Number(viewBox![1])).toBe(r.moduleCount + QUIET_ZONE_MODULES * 2)
  })
})
