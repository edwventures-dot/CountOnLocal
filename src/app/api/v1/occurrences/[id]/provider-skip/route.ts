/**
 * POST /v1/occurrences/{id}/provider-skip
 *
 * The provider cannot deliver this visit. API_CONTRACT, Occurrences:
 * "Applies provider-skip policy and credit."
 *
 * Always credits the customer, regardless of notice. The work was sold and
 * not done, and a provider cancelling three weeks ahead still did not do
 * it. domain/credit.ts holds the reasoning.
 *
 * Named provider-skip rather than skip on purpose. The customer's skip is a
 * different endpoint with different money attached, and one endpoint taking
 * an actor parameter would put the decision of who pays into a request
 * body. Two routes, two authorisations, no ambiguity.
 */

import { authenticate, clientIp } from '@/server/auth'
import { skipOccurrence, skipSchema } from '@/server/occurrenceService'
import { loadProviderGateContext } from '@/server/providerGate'
import { canRunRoute } from '@/domain/gates'
import { civilDateIn } from '@/server/occurrenceJobs'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { apiError, apiOk, newRequestId } from '@/lib/http'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

export async function POST(request: Request, { params }: Params): Promise<Response> {
  const requestId = newRequestId()

  const auth = await authenticate()
  if (!auth.ok) {
    return apiError('UNAUTHENTICATED', 'Sign in to continue.', 401, { requestId })
  }

  const { id } = await params

  let body: unknown = {}
  try {
    const text = await request.text()
    if (text) body = JSON.parse(text)
  } catch {
    return apiError('INVALID_BODY', 'Send a JSON body.', 400, { requestId })
  }

  const parsed = skipSchema.safeParse({ ...(body as object), occurrenceId: id })
  if (!parsed.success) {
    return apiError('VALIDATION_FAILED', 'Check the highlighted fields.', 422, { requestId })
  }

  const db = supabaseAdmin()
  const now = new Date()

  const gateContext = await loadProviderGateContext({
    db,
    providerUserId: auth.auth.userId,
    roles: auth.auth.roles,
    now,
  })
  if (!gateContext) {
    return apiError('NOT_A_PROVIDER', 'This account does not run a route.', 403, { requestId })
  }

  const gate = canRunRoute(gateContext)
  if (!gate.allowed) {
    return apiError(
      gate.code,
      gate.code === 'GUARDIAN_APPROVAL_REQUIRED'
        ? 'Guardian approval is required to continue.'
        : 'This account cannot run a route.',
      403,
      { requestId },
    )
  }

  // Notice is judged on the occurrence's own local date, not the server's.
  const occurrenceZone = await zoneOf(db, id)

  const result = await skipOccurrence({
    db,
    occurrenceId: parsed.data.occurrenceId,
    actor: 'provider',
    actorUserId: auth.auth.userId,
    today: civilDateIn(occurrenceZone, now),
    ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
    ip: clientIp(request),
  })

  if (!result.ok) {
    const status =
      result.code === 'NOT_FOUND' ? 404 : result.code === 'NOT_YOUR_OCCURRENCE' ? 403 : 409
    return apiError(result.code, result.message, status, { requestId })
  }

  return apiOk({
    occurrenceId: parsed.data.occurrenceId,
    state: result.state,
    credit: {
      applied: result.credit.credited,
      amountCents: result.credit.amountCents,
      reason: result.credit.code,
      message: result.credit.message,
    },
  })
}

/** The occurrence's own zone, falling back to UTC if it cannot be read. */
async function zoneOf(
  db: ReturnType<typeof supabaseAdmin>,
  occurrenceId: string,
): Promise<string> {
  const { data } = await db
    .from('service_occurrences')
    .select('local_timezone')
    .eq('id', occurrenceId)
    .maybeSingle()
  return data?.local_timezone ?? 'UTC'
}
