/**
 * GET /v1/guardian/dashboard
 *
 * PRD section 15 in one call: the business and its public page, the
 * approved services, upcoming work with the addresses it happens at, the
 * active customer count, and payout status.
 *
 * Read through the caller's own client, so migration 0019 decides what
 * comes back. That migration is where the last line of PRD section 15 lives
 * -- "Guardian cannot silently read unrelated private drafts or export
 * customer data for non-service purposes" -- as two tiers: consent data
 * from guardian_started onward, operational data only once verified.
 *
 * Never cached. It contains customer addresses.
 */

import { authenticate } from '@/server/auth'
import { getGuardianDashboard } from '@/server/guardianDashboard'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { apiError, apiOk, newRequestId } from '@/lib/http'

export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  const requestId = newRequestId()

  const auth = await authenticate()
  if (!auth.ok) {
    return apiError('UNAUTHENTICATED', 'Sign in to continue.', 401, { requestId })
  }

  const url = new URL(request.url)
  const relationshipId = url.searchParams.get('relationshipId') ?? undefined

  const db = await createSupabaseServerClient()

  const result = await getGuardianDashboard({
    db,
    adminDb: supabaseAdmin(),
    guardianUserId: auth.auth.userId,
    now: new Date(),
    ...(relationshipId ? { relationshipId } : {}),
  })

  if (!result.ok) {
    return apiError(
      result.code,
      result.message,
      result.code === 'NO_RELATIONSHIP' ? 404 : 500,
      { requestId },
    )
  }

  return apiOk(result.dashboard)
}
