/**
 * POST /v1/subscriptions/{id}/skip   the customer skips a visit
 * GET  /v1/subscriptions/{id}/skip   what would happen if they did
 *
 * API_CONTRACT, Subscriptions: "Skips specified occurrence/date range under
 * notice policy."
 *
 * The GET exists because PRD section 21 requires it: "UI shows whether the
 * occurrence will be credited before confirmation." It shares one code path
 * with the POST, so the warning and the outcome cannot disagree -- a
 * preview that says "free" followed by a charge would be the worst possible
 * version of this feature.
 *
 * Note there is no guardian gate here. This is the customer's own action on
 * their own subscription, and a provider's guardian state is not the
 * customer's business -- nor should a revoked guardian relationship stop a
 * customer from declining a visit.
 *
 * V1 takes one occurrence at a time. The contract mentions a date range;
 * that is a loop over this same decision and is not built yet rather than
 * being half-built here.
 */

import { authenticate, clientIp } from '@/server/auth'
import { previewSkip, skipOccurrence } from '@/server/occurrenceService'
import { civilDateIn } from '@/server/occurrenceJobs'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { apiError, apiOk, newRequestId } from '@/lib/http'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

/**
 * The occurrence being skipped is named in the query or the body rather
 * than the path, because the path already carries the subscription. The
 * service checks it belongs to that subscription's customer either way.
 */
async function resolve(
  request: Request,
  subscriptionId: string,
): Promise<{ occurrenceId: string; zone: string } | null> {
  const url = new URL(request.url)
  let occurrenceId = url.searchParams.get('occurrenceId') ?? ''

  if (!occurrenceId && request.method === 'POST') {
    try {
      const text = await request.text()
      if (text) occurrenceId = (JSON.parse(text) as { occurrenceId?: string }).occurrenceId ?? ''
    } catch {
      return null
    }
  }
  if (!occurrenceId) return null

  const { data } = await supabaseAdmin()
    .from('service_occurrences')
    .select('id, local_timezone, subscription_id')
    .eq('id', occurrenceId)
    .maybeSingle()

  // Belonging to the named subscription is checked here so a mismatched
  // pair is a 404 rather than a confusing authorisation error later.
  if (!data || data.subscription_id !== subscriptionId) return null

  return { occurrenceId: data.id, zone: data.local_timezone }
}

export async function GET(request: Request, { params }: Params): Promise<Response> {
  const requestId = newRequestId()

  const auth = await authenticate()
  if (!auth.ok) return apiError('UNAUTHENTICATED', 'Sign in to continue.', 401, { requestId })

  const { id } = await params
  const target = await resolve(request, id)
  if (!target) {
    return apiError('NOT_FOUND', 'No such visit on this subscription.', 404, { requestId })
  }

  const result = await previewSkip({
    db: supabaseAdmin(),
    occurrenceId: target.occurrenceId,
    actorUserId: auth.auth.userId,
    today: civilDateIn(target.zone, new Date()),
  })

  if (!result.ok) {
    return apiError(result.code, result.message, result.code === 'NOT_FOUND' ? 404 : 403, {
      requestId,
    })
  }

  return apiOk({
    occurrenceId: target.occurrenceId,
    willBeCredited: result.credit.credited,
    creditCents: result.credit.amountCents,
    reason: result.credit.code,
    message: result.credit.message,
  })
}

export async function POST(request: Request, { params }: Params): Promise<Response> {
  const requestId = newRequestId()

  const auth = await authenticate()
  if (!auth.ok) return apiError('UNAUTHENTICATED', 'Sign in to continue.', 401, { requestId })

  const { id } = await params
  const target = await resolve(request, id)
  if (!target) {
    return apiError('NOT_FOUND', 'No such visit on this subscription.', 404, { requestId })
  }

  const result = await skipOccurrence({
    db: supabaseAdmin(),
    occurrenceId: target.occurrenceId,
    actor: 'customer',
    actorUserId: auth.auth.userId,
    today: civilDateIn(target.zone, new Date()),
    ip: clientIp(request),
  })

  if (!result.ok) {
    const status =
      result.code === 'NOT_FOUND' ? 404 : result.code === 'NOT_YOUR_OCCURRENCE' ? 403 : 409
    return apiError(result.code, result.message, status, { requestId })
  }

  return apiOk({
    occurrenceId: target.occurrenceId,
    state: result.state,
    credited: result.credit.credited,
    creditCents: result.credit.amountCents,
    message: result.credit.message,
  })
}
