/**
 * QR codes for flyers.
 *
 * The only place in the codebase that knows the `qrcode` package exists.
 * Contained deliberately: if it is ever swapped, this file is the change.
 *
 * ## Why a library rather than an encoder written here
 *
 * Encoding a QR correctly means Reed-Solomon over GF(256), eight mask
 * patterns chosen by penalty scoring, and format and version bits. A subtly
 * wrong mask produces a symbol that renders beautifully and does not scan,
 * and there is no scanner in the test loop to catch it -- the failure would
 * surface on fifty doors.
 *
 * ## SVG, not PNG
 *
 * A flyer is printed. An SVG is vector, so it is crisp at whatever DPI the
 * provider's printer manages; a PNG sized for the screen turns to mush at
 * 300dpi, and a PNG sized for 300dpi is a large base64 blob in a document
 * somebody is generating four at a time.
 *
 * ## Error correction level Q
 *
 * 25% recovery rather than the usual 15%. These end up on doors and
 * lampposts: rained on, folded, thumbtacked through a corner, scanned at an
 * angle in bad light. The extra redundancy costs a slightly denser symbol
 * and buys a code that still works after a week outside.
 */

import QRCode from 'qrcode'

/** Recovery level. See the header for why this is not the default. */
export const ERROR_CORRECTION = 'Q' as const

/**
 * Quiet zone, in modules.
 *
 * Four is the spec minimum and skipping it is the classic reason a printed
 * code fails to scan -- a reader needs the blank border to find the symbol
 * against the paper.
 */
export const QUIET_ZONE_MODULES = 4

export type QrResult =
  | { ok: true; dataUri: string; version: number; moduleCount: number }
  | { ok: false; message: string }

/**
 * A QR for `text`, as an SVG data URI ready for an img src.
 *
 * Returns a failure rather than throwing: a flyer without a code is still a
 * usable flyer -- the URL is printed as text beside it -- and a Grow screen
 * that errors because a QR could not be built would be a worse outcome than
 * one that prints without it.
 */
export async function qrSvgDataUri(text: string): Promise<QrResult> {
  if (!text.trim()) return { ok: false, message: 'Nothing to encode.' }

  try {
    const svg = await QRCode.toString(text, {
      type: 'svg',
      errorCorrectionLevel: ERROR_CORRECTION,
      margin: QUIET_ZONE_MODULES,
      // Ink on white. A QR reader needs contrast, and the brand lime does
      // not have enough of it against paper.
      color: { dark: '#14263A', light: '#FFFFFF' },
    })

    const matrix = QRCode.create(text, { errorCorrectionLevel: ERROR_CORRECTION })

    return {
      ok: true,
      dataUri: `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`,
      version: matrix.version,
      moduleCount: matrix.modules.size,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[qr] encode failed', { message })
    return { ok: false, message }
  }
}

/**
 * The raw module matrix, for tests and for anything that needs to inspect
 * the symbol rather than render it.
 */
export function qrModules(text: string): boolean[][] {
  const matrix = QRCode.create(text, { errorCorrectionLevel: ERROR_CORRECTION })
  const size = matrix.modules.size
  const rows: boolean[][] = []
  for (let r = 0; r < size; r++) {
    const row: boolean[] = []
    for (let c = 0; c < size; c++) row.push(Boolean(matrix.modules.get(r, c)))
    rows.push(row)
  }
  return rows
}
