/**
 * Printable flyers, share links and referral codes.
 *
 * UX_UI_SPEC section 13 calls the Grow screen "strategically important",
 * and this is the part of it that leaves the building: a provider prints
 * these, walks their own street, and puts them through doors.
 *
 * ## Everything is escaped, because this becomes a document
 *
 * A flyer is HTML built from provider-supplied strings -- a business name, a
 * service name, a headline they wrote. It is then opened in a browser and
 * printed. Interpolating those unescaped would be an injection into a page
 * the provider hands to their neighbours, and UX_UI_SPEC's own note that V1
 * stores plain text rather than arbitrary HTML is the reason there is
 * nothing here that renders markup.
 *
 * ## No customer data, ever
 *
 * A flyer is a public document going through the doors of people who are
 * not customers. It carries the business name, the service, the price, the
 * public area label and the storefront URL. It does not carry a customer
 * count below the privacy threshold, an address, or anything about who
 * already subscribes -- PRD section 14's "never expose which houses
 * subscribe" applies most literally to a piece of paper on a doormat.
 *
 * ## The QR code
 *
 * Generated in src/server/qr.ts, which is the only file that knows the
 * encoder exists. Passed in as a data URI rather than produced here, so
 * this module stays a pure string-builder that a test can exercise without
 * touching an encoder.
 *
 * When one is not supplied -- generation failed, or a caller did not ask
 * for one -- the slot renders a labelled placeholder saying so, rather than
 * a decorative square somebody might print believing it works. The URL is
 * printed as text beside it either way.
 */

import { socialProof, type SocialProof } from '@/domain/density'

/** Everything a flyer needs. Assembled by the caller from its own queries. */
export type FlyerInput = {
  businessName: string
  serviceName: string
  /** Formatted, e.g. "$3". */
  price: string
  /** e.g. "/week". */
  priceUnit: string
  /** Public neighbourhood label. Never a street. */
  areaLabel: string | null
  /** The page a neighbour lands on. */
  storefrontUrl: string
  /** Provider's own line, if they wrote one. */
  headline?: string | undefined
  /** Optional, and withheld below the privacy threshold. */
  activeCustomers?: number | undefined
  /** SVG data URI for the QR image. See src/server/qr.ts. */
  qrDataUri?: string | undefined
}

/**
 * HTML entity escaping for text going into a document.
 *
 * Covers the five characters that matter in element and attribute
 * positions. Everything interpolated below goes through this.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * The QR block.
 *
 * With a data URI it is an image. Without one it is a labelled placeholder
 * that says plainly that the code is missing, rather than a decorative
 * square somebody might mistake for a working code and print anyway.
 */
function qrMarkup(input: FlyerInput): string {
  if (input.qrDataUri) {
    return `<img class="qr" src="${escapeHtml(input.qrDataUri)}" alt="Scan to open ${escapeHtml(input.businessName)}">`
  }
  return `<div class="qr qr-missing" role="img" aria-label="QR code not generated">QR<br><span>not generated</span></div>`
}

/**
 * One flyer's inner markup.
 *
 * Exported so a test can assert on a single card without parsing a whole
 * printable sheet.
 */
export function flyerCard(input: FlyerInput): string {
  const proof: SocialProof =
    input.activeCustomers === undefined
      ? { show: false }
      : socialProof({
          activeCustomers: input.activeCustomers,
          ...(input.areaLabel ? { areaLabel: input.areaLabel } : {}),
        })

  const headline = input.headline?.trim()
    ? input.headline.trim()
    : 'One less thing to remember every week.'

  // The URL is shown as text as well as encoded. A QR is useless to
  // somebody reading a flyer on a phone they are already holding, and it is
  // useless to anyone whose camera will not focus in the rain.
  return `<div class="flyer">
      <div class="accent"></div>
      <div class="kicker">Neighborhood service</div>
      <h1>${escapeHtml(headline)}</h1>
      <div class="service">${escapeHtml(input.serviceName)}</div>
      <div class="price">${escapeHtml(input.price)}<small>${escapeHtml(input.priceUnit)}</small></div>
      ${proof.show ? `<div class="proof">${escapeHtml(proof.label)}</div>` : ''}
      <div><span class="pill">Check your address</span></div>
      <div class="row">
        ${qrMarkup(input)}
        <div class="scan">SCAN OR VISIT<br><span class="url">${escapeHtml(input.storefrontUrl)}</span></div>
      </div>
      <div class="brand"><strong>${escapeHtml(input.businessName)}</strong><span>powered by Count On Local</span></div>
    </div>`
}

/**
 * A printable sheet.
 *
 * Four to a page, because a provider printing these is doing it on a home
 * printer and paying for the paper.
 */
export function renderFlyerSheet(input: FlyerInput, copies = 4): string {
  const cards = Array.from({ length: Math.max(1, Math.min(8, copies))
  }, () => flyerCard(input)).join('\n    ')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(input.businessName)} -- flyer</title>
<style>
@page { size: letter; margin: .35in; }
* { box-sizing: border-box; }
body { margin: 0; font-family: Inter, Arial, sans-serif; background:#F6F3EA; color:#14263A; }
.sheet { width: 7.8in; min-height: 10.3in; margin:auto; display:grid; grid-template-columns:1fr 1fr; gap:.22in; }
.flyer { background:white; border:3px solid #14263A; border-radius:22px; padding:.28in; display:flex; flex-direction:column; min-height:4.95in; position:relative; overflow:hidden; }
.kicker { font-size:11px; font-weight:800; letter-spacing:.12em; text-transform:uppercase; }
h1 { font-size:31px; line-height:1.0; margin:.12in 0 .08in; letter-spacing:-.04em; }
.service { font-size:18px; font-weight:700; margin:.05in 0; }
.price { font-size:38px; font-weight:900; margin:.12in 0; }
.price small { font-size:15px; font-weight:700; }
.proof { font-size:13px; font-weight:700; color:#607080; margin-bottom:.08in; }
.row { display:flex; align-items:center; gap:.18in; margin-top:auto; }
.qr { width:1.25in; height:1.25in; border:8px solid #14263A; padding:6px; background:white; object-fit:contain; }
.qr-missing { display:flex; flex-direction:column; align-items:center; justify-content:center; font-size:13px; font-weight:800; text-align:center; color:#C43E3E; border-style:dashed; }
.qr-missing span { font-size:10px; font-weight:600; }
.scan { font-size:14px; line-height:1.35; font-weight:700; }
.url { font-weight:500; font-size:13px; word-break:break-all; }
.brand { margin-top:.18in; padding-top:.12in; border-top:1px solid #DDE3E6; font-size:11px; display:flex; justify-content:space-between; align-items:center; }
.pill { display:inline-block; background:#C7F34A; padding:7px 11px; border-radius:999px; font-weight:800; }
.accent { position:absolute; width:120px; height:120px; border-radius:50%; background:#C7F34A; right:-65px; top:-55px; }
@media screen { body { padding:20px; } .sheet{ box-shadow:0 12px 40px rgba(20,38,58,.12); } }
@media print { body { background:white; } }
</style>
</head>
<body>
  <div class="sheet">
    ${cards}
  </div>
</body>
</html>`
}

/**
 * The link a provider shares.
 *
 * A referral code rides along as a query parameter rather than a distinct
 * path, so the same storefront URL works with or without one and a link
 * that loses its parameter still lands somewhere useful.
 */
export function shareUrl(args: { storefrontUrl: string; referralCode?: string | undefined }): string {
  if (!args.referralCode) return args.storefrontUrl
  const url = new URL(args.storefrontUrl)
  url.searchParams.set('ref', args.referralCode)
  return url.toString()
}
