import { describe, expect, it } from 'vitest'
import {
  containsMetadataMarker,
  MAX_PHOTO_BYTES,
  sanitisePhoto,
  sniffKind,
} from '../photo'

/**
 * A JPEG built by hand, so the test knows exactly what is in it.
 *
 * SOI, an APP1 carrying an EXIF block with a GPS-looking string, an APP0
 * JFIF that should survive, a comment, then SOS and some scan data.
 */
function jpegWithExif(): Uint8Array {
  const exifPayload = Array.from(
    new TextEncoder().encode('Exif\0\0GPSLatitude 30.2672 GPSLongitude -97.7431'),
  )
  const app1Len = exifPayload.length + 2
  const jfif = Array.from(new TextEncoder().encode('JFIF\0'))
  const app0Len = jfif.length + 2
  const comment = Array.from(new TextEncoder().encode('taken on a phone'))
  const comLen = comment.length + 2

  return Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xe1, (app1Len >> 8) & 0xff, app1Len & 0xff, ...exifPayload,
    0xff, 0xe0, (app0Len >> 8) & 0xff, app0Len & 0xff, ...jfif,
    0xff, 0xfe, (comLen >> 8) & 0xff, comLen & 0xff, ...comment,
    0xff, 0xda, 0x00, 0x08, 1, 2, 3, 4, 5, 6,
    0xff, 0xd9,
  ])
}

function pngWithText(): Uint8Array {
  const chunk = (type: string, data: number[]) => {
    const t = Array.from(new TextEncoder().encode(type))
    const len = data.length
    return [(len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff, ...t, ...data, 0, 0, 0, 0]
  }
  const location = Array.from(new TextEncoder().encode('GPS\0 30.2672, -97.7431'))
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]),
    ...chunk('tEXt', location),
    ...chunk('eXIf', location),
    ...chunk('IDAT', [1, 2, 3]),
    ...chunk('IEND', []),
  ])
}

describe('what it is, not what it claims to be', () => {
  it('recognises a JPEG and a PNG by their bytes', () => {
    expect(sniffKind(jpegWithExif())).toBe('image/jpeg')
    expect(sniffKind(pngWithText())).toBe('image/png')
  })

  it('refuses something wearing an image name', () => {
    // A browser sends whatever it likes, and these bytes get served back
    // to other people.
    const html = new TextEncoder().encode('<!doctype html><script>alert(1)</script>')
    expect(sniffKind(html)).toBeNull()
    expect(sanitisePhoto(html).ok).toBe(false)
  })

  it('refuses a PDF', () => {
    expect(sanitisePhoto(new TextEncoder().encode('%PDF-1.7 ...')).ok).toBe(false)
  })

  it('does not say what it thought the file was', () => {
    // Naming it tells somebody probing exactly how the check works.
    const r = sanitisePhoto(new TextEncoder().encode('%PDF-1.7'))
    if (!r.ok) expect(r.message).not.toMatch(/pdf|html|gif/i)
  })

  it('refuses empty and oversized files', () => {
    expect(sanitisePhoto(new Uint8Array(0))).toMatchObject({ ok: false, code: 'EMPTY' })
    const huge = new Uint8Array(MAX_PHOTO_BYTES + 1)
    huge.set([0xff, 0xd8, 0xff])
    expect(sanitisePhoto(huge)).toMatchObject({ ok: false, code: 'TOO_LARGE' })
  })
})

describe('EXIF actually leaves', () => {
  it('removes the GPS data from a JPEG', () => {
    const original = jpegWithExif()
    expect(containsMetadataMarker(original)).toBe(true)

    const r = sanitisePhoto(original)
    expect(r.ok).toBe(true)
    if (!r.ok) return

    // The location of a fourteen-year-old at a precise time.
    const text = new TextDecoder('latin1').decode(r.bytes)
    expect(text).not.toContain('GPSLatitude')
    expect(text).not.toContain('30.2672')
    expect(containsMetadataMarker(r.bytes)).toBe(false)
  })

  it('reports how many segments went, rather than only shrinking', () => {
    // A smaller file is not evidence the right bytes were removed.
    const r = sanitisePhoto(jpegWithExif())
    if (r.ok) expect(r.strippedSegments).toBe(2) // APP1 and the comment
  })

  it('keeps the image data and the JFIF header', () => {
    const r = sanitisePhoto(jpegWithExif())
    if (!r.ok) return
    const text = new TextDecoder('latin1').decode(r.bytes)
    expect(text).toContain('JFIF')
    // Still a JPEG.
    expect(sniffKind(r.bytes)).toBe('image/jpeg')
    // Scan data survived.
    expect(r.bytes[r.bytes.length - 2]).toBe(0xff)
    expect(r.bytes[r.bytes.length - 1]).toBe(0xd9)
  })

  it('removes text and eXIf chunks from a PNG', () => {
    const original = pngWithText()
    expect(containsMetadataMarker(original)).toBe(true)

    const r = sanitisePhoto(original)
    expect(r.ok).toBe(true)
    if (!r.ok) return

    const text = new TextDecoder('latin1').decode(r.bytes)
    expect(text).not.toContain('30.2672')
    expect(text).not.toContain('tEXt')
    expect(text).not.toContain('eXIf')
    expect(sniffKind(r.bytes)).toBe('image/png')
    expect(text).toContain('IDAT')
    expect(text).toContain('IEND')
  })

  it('leaves a clean photo alone', () => {
    const clean = Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x08, 1, 2, 0xff, 0xd9])
    const r = sanitisePhoto(clean)
    if (r.ok) expect(r.strippedSegments).toBe(0)
  })
})

describe('malformed input is refused, not guessed at', () => {
  it('refuses a JPEG that ends mid-segment', () => {
    const truncated = Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0x00])
    expect(sanitisePhoto(truncated)).toMatchObject({ ok: false, code: 'MALFORMED' })
  })

  it('refuses a JPEG with a segment length past the end', () => {
    const lying = Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0x7f, 0xff, 1, 2, 3])
    expect(sanitisePhoto(lying)).toMatchObject({ ok: false, code: 'MALFORMED' })
  })

  it('refuses a PNG chunk that claims more than the file holds', () => {
    const lying = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x7f, 0xff, 0xff, 0xff, 0x49, 0x48, 0x44, 0x52, 1, 2,
    ])
    expect(sanitisePhoto(lying)).toMatchObject({ ok: false, code: 'MALFORMED' })
  })
})
