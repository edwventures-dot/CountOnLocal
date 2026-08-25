/**
 * GET  /v1/provider/payouts/status   read the mirrored state
 * POST /v1/provider/payouts/status   force a sync from Stripe first
 *
 * GET is cheap: webhooks keep the mirror current, so a dashboard poll costs
 * no Stripe round trip. POST is for the return leg of onboarding, where the
 * webhook may not have landed yet and the provider is staring at the screen
 * waiting to be told it worked.
 */

import { authenticate } from '@/server/auth'
import { getPayoutStatus, syncAccountState } from '@/server/connectOnboarding'
import { hasPermission } from '@/domain/roles'
import { apiError, apiOk, newRequestId } from '@/lib/http'
import { supabaseAdmin } from '@/lib/supabase/admin'

async function handle(forceSync: boolean): Promise<Response> {
  const requestId = newRequestId()

  const auth = await authenticate()
  if (!auth.ok) {
    if (auth.code === 'NO_DOMAIN_USER') {
      return apiError('ACCOUNT_NOT_PROVISIONED', 'This account needs review. Please contact support.', 409, { requestId })
    }
    return apiError('UNAUTHENTICATED', 'Sign in to continue.', 401, { requestId })
  }

  if (!hasPermission(auth.auth.roles, 'business:draft')) {
    return apiError('NOT_AUTHORIZED', 'This account cannot perform that action.', 403, { requestId })
  }

  const db = supabaseAdmin()
  const now = new Date()

  if (forceSync) {
    const current = await getPayoutStatus({ db, providerUserId: auth.auth.userId, now })
    if (current.ok && current.status.stage !== 'not_started') {
      const { data: holder } = await db
        .from('users')
        .select('stripe_connected_account_id')
        .eq('id', current.status.holderUserId!)
        .maybeSingle()
      if (holder?.stripe_connected_account_id) {
        // A sync failure is not fatal -- fall through and serve the mirror
        // rather than erroring at a provider who just finished a form.
        await syncAccountState({ db, accountId: holder.stripe_connected_account_id, now })
      }
    }
  }

  const result = await getPayoutStatus({ db, providerUserId: auth.auth.userId, now })
  if (!result.ok) {
    return apiError(result.code, 'Complete provider onboarding first.', 409, { requestId })
  }

  const s = result.status
  return apiOk({
    stage: s.stage,
    canReceivePayments: s.canReceivePayments,
    completedBy: s.holder === 'guardian' ? 'guardian' : s.holder === 'self' ? 'provider' : null,
    guardianState: s.guardianState,
    // Field paths Stripe is still waiting on from the holder. Safe to show:
    // these are form field names, not the values behind them.
    requirementsDue: s.requirementsDue,
  })
}

export async function GET(): Promise<Response> {
  return handle(false)
}

export async function POST(): Promise<Response> {
  return handle(true)
}
