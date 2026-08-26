/**
 * GET /v1/provider/grow
 *
 * The Grow screen. UX_UI_SPEC section 13 calls it strategically important
 * and PRD section 14 says why: the platform optimises for revenue per local
 * route, not map radius, and this is where that argument gets made to the
 * person walking the route.
 *
 * One prompt per service, not a list of suggestions. The prompt to expand
 * has to earn its place; the prompt to fill in is the default, because a
 * provider who widens their area before filling it walks further for the
 * same money.
 *
 * Read through the caller's own client so RLS decides what comes back, with
 * the privileged client used only to mint a referral code -- 0022 allows no
 * client writes.
 */

import { authenticate } from '@/server/auth'
import { getGrowDashboard } from '@/server/growService'
import { hasPermission } from '@/domain/roles'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { apiError, apiOk, newRequestId } from '@/lib/http'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
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

  return apiOk(result.dashboard)
}
