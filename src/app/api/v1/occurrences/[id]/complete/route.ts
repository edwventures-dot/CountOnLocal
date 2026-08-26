/**
 * POST /v1/occurrences/{id}/complete
 *
 * The provider marks a stop done. API_CONTRACT, Occurrences.
 *
 * Three checks, in order, and the order matters:
 *
 *   1. authenticated at all;
 *   2. guardian state permits running a route -- a revoked minor provider
 *      must not keep accruing completed work (SAFETY_TRUST_POLICY 2);
 *   3. this occurrence is actually theirs, and the transition is legal.
 *
 * The third is inside occurrenceService, which resolves ownership from the
 * database rather than trusting anything here. Both this file and that one
 * refuse independently: a mistake in one is not enough to complete somebody
 * else's stop.
 *
 * No money moves. The earning is recognised at cycle settlement.
 */

import { authenticate, clientIp } from '@/server/auth'
import { completeOccurrence, completeSchema } from '@/server/occurrenceService'
import { loadProviderGateContext } from '@/server/providerGate'
import { canRunRoute } from '@/domain/gates'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { apiError, apiOk, newRequestId } from '@/lib/http'
import { track } from '@/server/analytics'

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

  const parsed = completeSchema.safeParse({ ...(body as object), occurrenceId: id })
  if (!parsed.success) {
    return apiError('VALIDATION_FAILED', 'Check the highlighted fields.', 422, {
      requestId,
      fieldErrors: flatten(parsed.error.issues),
    })
  }

  const db = supabaseAdmin()

  const gateContext = await loadProviderGateContext({
    db,
    providerUserId: auth.auth.userId,
    roles: auth.auth.roles,
    now: new Date(),
  })
  if (!gateContext) {
    return apiError('NOT_A_PROVIDER', 'This account does not run a route.', 403, { requestId })
  }

  const gate = canRunRoute(gateContext)
  if (!gate.allowed) {
    return apiError(
      gate.code,
      gate.code === 'GUARDIAN_APPROVAL_REQUIRED'
        ? // The exact wording SAFETY_TRUST_POLICY 2 permits. Nothing about
          // who revoked, or why.
          'Guardian approval is required to continue.'
        : 'This account cannot run a route.',
      403,
      { requestId },
    )
  }

  const result = await completeOccurrence({
    db,
    occurrenceId: parsed.data.occurrenceId,
    actorUserId: auth.auth.userId,
    ...(parsed.data.note ? { note: parsed.data.note } : {}),
    ip: clientIp(request),
  })

  if (!result.ok) {
    const status =
      result.code === 'NOT_FOUND' ? 404 : result.code === 'NOT_YOUR_OCCURRENCE' ? 403 : 409
    return apiError(result.code, result.message, status, { requestId })
  }

  track({
    event: 'occurrence_completed',
    userId: auth.auth.userId,
    properties: { occurrence_id: parsed.data.occurrenceId, occurrence_state: result.state },
  })

  return apiOk({ occurrenceId: parsed.data.occurrenceId, state: result.state })
}

function flatten(issues: readonly { path: PropertyKey[]; message: string }[]) {
  const out: Record<string, string> = {}
  for (const i of issues) out[String(i.path[0] ?? 'body')] = i.message
  return out
}
