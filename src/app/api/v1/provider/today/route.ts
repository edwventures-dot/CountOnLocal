/**
 * GET /v1/provider/today
 *
 * The provider's route for today: stops in order, expected earnings, an
 * estimated length, and how much of it is done. PRD section 13.
 *
 * Read through the caller's own client, not the privileged one. Row level
 * security decides which stops and which addresses come back -- 0017 grants
 * a provider exactly the addresses on live subscriptions for their own
 * business.
 *
 * The provider id comes from the session, never from the request. RLS keeps
 * another business's rows out; the id states which role the caller is acting
 * in, because a customer can legitimately read the same occurrence rows and
 * would otherwise get their own visits back dressed up as a route.
 *
 * API_CONTRACT: "For minor provider, this endpoint requires valid guardian
 * state." A revoked or expired relationship means no route -- the addresses
 * on it are exactly what a guardian revocation is meant to withdraw access
 * to, and handing them over anyway would make the revocation cosmetic.
 *
 * Never cached. A route changes as stops are completed, and it contains a
 * customer's address and gate code.
 */

import { authenticate } from '@/server/auth'
import { getTodayRoute } from '@/server/routeService'
import { hasPermission } from '@/domain/roles'
import { loadProviderGateContext } from '@/server/providerGate'
import { canRunRoute } from '@/domain/gates'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { apiError, apiOk, newRequestId } from '@/lib/http'
import type { TravelMode } from '@/domain/route'

export const dynamic = 'force-dynamic'

const TRAVEL_MODES: readonly string[] = ['walking', 'cycling', 'driving']

export async function GET(request: Request): Promise<Response> {
  const requestId = newRequestId()

  const auth = await authenticate()
  if (!auth.ok) {
    return apiError('UNAUTHENTICATED', 'Sign in to continue.', 401, { requestId })
  }

  // The same permission that gates having a business at all. A customer
  // account has no route and should be told so plainly.
  if (!hasPermission(auth.auth.roles, 'business:draft')) {
    return apiError('NOT_AUTHORIZED', 'This account does not run a route.', 403, { requestId })
  }

  const url = new URL(request.url)
  const modeParam = url.searchParams.get('travelMode')
  const travelMode: TravelMode | undefined =
    modeParam && TRAVEL_MODES.includes(modeParam) ? (modeParam as TravelMode) : undefined

  // Gate on guardian state before any address is read. Uses the privileged
  // client only to read the provider's own profile -- the route itself is
  // still read through the caller's session so RLS applies.
  const gateContext = await loadProviderGateContext({
    db: supabaseAdmin(),
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
        ? 'Guardian approval is required to continue.'
        : 'This account cannot run a route.',
      403,
      { requestId },
    )
  }

  const db = await createSupabaseServerClient()

  const result = await getTodayRoute({
    db,
    providerUserId: auth.auth.userId,
    now: new Date(),
    ...(travelMode ? { travelMode } : {}),
  })

  if (!result.ok) {
    return apiError(result.code, result.message, 500, { requestId })
  }

  const r = result.route

  return apiOk({
    date: r.date,
    timezone: r.timezone,
    expectedEarningsCents: r.expectedEarningsCents,
    // Labelled estimates on purpose: these are straight-line figures, not
    // street distance. See domain/route.ts.
    estimatedMetres: r.estimatedMetres,
    estimatedMinutes: r.estimatedMinutes,
    progress: r.progress,
    unplacedCount: r.unplacedCount,
    stops: r.stops.map((s) => ({
      occurrenceId: s.occurrenceId,
      position: s.position,
      state: s.state,
      window: { start: s.windowStart, end: s.windowEnd },
      valueCents: s.valueCents,
      address: s.address,
      instructions: s.instructions,
    })),
  })
}
