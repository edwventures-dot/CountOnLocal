/**
 * GET /v1/provider/flyer?serviceId=...&copies=4
 *
 * Returns a printable HTML sheet, not JSON. A provider opens it and hits
 * print; there is no client to render.
 *
 * A flyer is a public document going through the doors of people who are
 * not customers, so it carries the business, the service, the price, the
 * public area label and the storefront URL -- and nothing about who already
 * subscribes. PRD section 14's "never expose which houses subscribe"
 * applies most literally to a piece of paper on a doormat, and the customer
 * count is withheld below the privacy threshold in domain/density.ts.
 *
 * Every provider-supplied string is HTML-escaped. This becomes a document
 * they hand to their neighbours.
 */

import { authenticate } from '@/server/auth'
import { hasPermission } from '@/domain/roles'
import { renderFlyerSheet } from '@/server/flyerService'
import { getGrowDashboard } from '@/server/growService'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { formatCents } from '@/domain/money'
import { qrSvgDataUri } from '@/server/qr'
import { apiError, newRequestId } from '@/lib/http'

export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  const requestId = newRequestId()

  const auth = await authenticate()
  if (!auth.ok) return apiError('UNAUTHENTICATED', 'Sign in to continue.', 401, { requestId })

  if (!hasPermission(auth.auth.roles, 'business:draft')) {
    return apiError('NOT_AUTHORIZED', 'This account does not run a business.', 403, { requestId })
  }

  const db = await createSupabaseServerClient()
  const result = await getGrowDashboard({ db, providerUserId: auth.auth.userId })
  if (!result.ok) {
    return apiError(result.code, result.message, result.code === 'NO_BUSINESS' ? 404 : 500, {
      requestId,
    })
  }

  const url = new URL(request.url)
  const serviceId = url.searchParams.get('serviceId')
  const service = serviceId
    ? result.dashboard.services.find((s) => s.serviceId === serviceId)
    : result.dashboard.services[0]

  if (!service) {
    return apiError('NOT_FOUND', 'No such service on this business.', 404, { requestId })
  }

  const copiesParam = Number(url.searchParams.get('copies'))
  const copies = Number.isFinite(copiesParam) && copiesParam > 0 ? Math.trunc(copiesParam) : 4

  // Price comes from the service row rather than the density view, so what
  // is printed is what a customer is actually charged.
  const { data: row } = await db
    .from('provider_services')
    .select('price_cents, price_unit')
    .eq('id', service.serviceId)
    .maybeSingle()

  const { data: biz } = await db
    .from('businesses')
    .select('public_area_label')
    .eq('slug', result.dashboard.storefrontUrl.split('/').pop() ?? '')
    .maybeSingle()

  // Encodes the share URL, so a scanned flyer is attributed to the code on
  // it. A failure is not fatal -- the URL is printed as text beside the
  // slot, and a flyer without a code still works.
  const shareTarget = result.dashboard.shareUrl
  const qr = await qrSvgDataUri(shareTarget)
  if (!qr.ok) {
    console.error('[flyer] qr generation failed', { requestId, message: qr.message })
  }

  const html = renderFlyerSheet(
    {
      businessName: result.dashboard.businessName,
      serviceName: service.publicName,
      price: row ? formatCents(row.price_cents).replace(/\.00$/, '') : '',
      priceUnit: row ? `/${row.price_unit}` : '',
      areaLabel: biz?.public_area_label ?? null,
      // The share URL, so a flyer that gets scanned is attributed.
      storefrontUrl: shareTarget,
      ...(qr.ok ? { qrDataUri: qr.dataUri } : {}),
      // Withheld below the privacy threshold by socialProof(); passing the
      // real count is safe because the domain decides whether it is shown.
      activeCustomers: service.density.activeCustomers,
    },
    copies,
  )

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // Contains a live route's customer count. Never cached anywhere.
      'Cache-Control': 'no-store, private',
    },
  })
}
