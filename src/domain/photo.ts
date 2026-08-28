/**
 * Making an uploaded photo safe to keep.
 *
 * CLAUDE.md rule 12: "Uploads are sanitized before storage: content-type +
 * magic-byte validation, EXIF stripped, private by default, authorized on
 * every fetch." This module does the first two and a half. Privacy and
 * authorization are the storage layer's job.
 *
 * ## Why the declared content type is not trusted
 *
 * A browser sends whatever it likes. `image/jpeg` on a file that is
 * actually an HTML document is the oldest trick there is, and it matters
 * here because these bytes get served back to other people. So the first
 * two or eight bytes decide what this is, and the header is only checked
 * for agreeing with them.
 *
 * ## Why EXIF is stripped rather than trusted to be absent
 *
 * A phone camera writes GPS coordinates into every photo by default. A
 * completion photo is taken standing outside a customer's house, by a
 * provider who is frequently fourteen. Left in, the file is a record of
 * exactly where a child was at a precise time, handed to whoever can fetch
 * it -- and Safety section 13 asks for it gone before persistent storage,
 * not before display.
 *
 * The stripping is structural rather than a library call: JPEG APPn
 * segments and PNG text chunks are removed by walking the container. That
 * keeps the dependency count at zero and, more usefully, means the failure
 * mode is a refusal rather than a silent pass-through.
 */

export const MAX_PHOTO_BYTES = 8 * 1024 * 1024

export type PhotoKind = 'image/jpeg' | 'image/png'

export type SanitiseResult =
  | { ok: true; bytes: Uint8Array; kind: PhotoKind; strippedSegments: number }
  | { ok: false; code: 'TOO_LARGE' | 'EMPTY' | 'UNSUPPORTED' | 'MALFORMED'; message: string }

/** What the first bytes actually say this is, ignoring any header. */
export function sniffKind(bytes: Uint8Array): PhotoKind | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length >= 8 && png.every((b, i) => bytes[i] === b)) return 'image/png'
  return null
}

export function sanitisePhoto(bytes: Uint8Array): SanitiseResult {
  if (bytes.length === 0) return { ok: false, code: 'EMPTY', message: 'That file was empty.' }
  if (bytes.length > MAX_PHOTO_BYTES) {
    return {
      ok: false,
      code: 'TOO_LARGE',
      message: `Photos must be under ${MAX_PHOTO_BYTES / (1024 * 1024)} MB.`,
    }
  }

  const kind = sniffKind(bytes)
  if (!kind) {
    // Deliberately not naming what it looked like. "That is a PDF" tells
    // somebody probing exactly how the check works.
    return { ok: false, code: 'UNSUPPORTED', message: 'Photos must be a JPEG or a PNG.' }
  }

  return kind === 'image/jpeg' ? stripJpeg(bytes) : stripPng(bytes)
}

/**
 * Removes every APPn segment from a JPEG.
 *
 * EXIF lives in APP1, XMP in APP1 too, and various makers scatter things
 * through APP2 to APP15. All of them are metadata; none is needed to
 * render the image. APP0 (JFIF) is kept because some decoders expect it
 * and it carries only density information.
 *
 * Everything from the start-of-scan marker onwards is entropy-coded image
 * data and is copied verbatim -- parsing further would mean decoding the
 * image, which is neither necessary nor safe.
 */
function stripJpeg(bytes: Uint8Array): SanitiseResult {
  const out: number[] = [0xff, 0xd8]
  let i = 2
  let stripped = 0

  while (i < bytes.length) {
    if (bytes[i] !== 0xff) {
      return { ok: false, code: 'MALFORMED', message: 'That JPEG could not be read.' }
    }

    // Fill bytes: a run of 0xFF is legal padding before a marker.
    let marker = bytes[i + 1]
    let markerAt = i + 1
    while (marker === 0xff) {
      markerAt += 1
      marker = bytes[markerAt]
    }
    if (marker === undefined) {
      return { ok: false, code: 'MALFORMED', message: 'That JPEG ended unexpectedly.' }
    }

    // Start of scan: the rest is compressed pixels.
    if (marker === 0xda) {
      for (let k = i; k < bytes.length; k++) out.push(bytes[k]!)
      break
    }

    // Standalone markers carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      out.push(0xff, marker)
      i = markerAt + 1
      continue
    }

    const lengthAt = markerAt + 1
    const hi = bytes[lengthAt]
    const lo = bytes[lengthAt + 1]
    if (hi === undefined || lo === undefined) {
      return { ok: false, code: 'MALFORMED', message: 'That JPEG ended unexpectedly.' }
    }
    const length = (hi << 8) | lo
    if (length < 2 || lengthAt + length > bytes.length) {
      return { ok: false, code: 'MALFORMED', message: 'That JPEG could not be read.' }
    }

    // APP1..APP15 go. APP0 stays.
    const isApp = marker >= 0xe0 && marker <= 0xef
    const isComment = marker === 0xfe
    if ((isApp && marker !== 0xe0) || isComment) {
      stripped += 1
    } else {
      out.push(0xff, marker)
      for (let k = lengthAt; k < lengthAt + length; k++) out.push(bytes[k]!)
    }

    i = lengthAt + length
  }

  return { ok: true, bytes: Uint8Array.from(out), kind: 'image/jpeg', strippedSegments: stripped }
}

/**
 * Removes text and metadata chunks from a PNG.
 *
 * PNG has no EXIF of its own historically, but eXIf exists now and tEXt,
 * iTXt and zTXt regularly carry camera software output including location.
 * tIME goes too: the exact second a photo was written is not needed and is
 * one more thing to correlate.
 */
function stripPng(bytes: Uint8Array): SanitiseResult {
  const DROP = new Set(['tEXt', 'iTXt', 'zTXt', 'eXIf', 'tIME'])
  const out: number[] = []
  for (let k = 0; k < 8; k++) out.push(bytes[k]!)

  let i = 8
  let stripped = 0

  while (i + 8 <= bytes.length) {
    const length =
      ((bytes[i]! << 24) | (bytes[i + 1]! << 16) | (bytes[i + 2]! << 8) | bytes[i + 3]!) >>> 0
    const type = String.fromCharCode(bytes[i + 4]!, bytes[i + 5]!, bytes[i + 6]!, bytes[i + 7]!)
    const end = i + 12 + length

    if (end > bytes.length) {
      return { ok: false, code: 'MALFORMED', message: 'That PNG could not be read.' }
    }

    if (DROP.has(type)) {
      stripped += 1
    } else {
      for (let k = i; k < end; k++) out.push(bytes[k]!)
    }

    i = end
    if (type === 'IEND') break
  }

  return { ok: true, bytes: Uint8Array.from(out), kind: 'image/png', strippedSegments: stripped }
}

/**
 * Whether any recognisable metadata marker survives.
 *
 * Used by the tests to assert the stripping worked rather than to trust
 * that it did. Deliberately looks for the markers themselves rather than
 * comparing sizes: a smaller file is not evidence the right bytes went.
 */
export function containsMetadataMarker(bytes: Uint8Array): boolean {
  const text = new TextDecoder('latin1').decode(bytes)
  return (
    text.includes('Exif\0') ||
    text.includes('http://ns.adobe.com/xap') ||
    text.includes('tEXt') ||
    text.includes('iTXt') ||
    text.includes('eXIf')
  )
}
