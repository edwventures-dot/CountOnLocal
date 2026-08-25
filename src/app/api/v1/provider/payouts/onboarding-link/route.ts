/**
 * POST /v1/provider/payouts/onboarding-link
 *
 * Returns a Stripe-hosted onboarding URL for whoever legally holds this
 * provider's payout account -- the guardian for a 13-17 provider, the
 * provider themselves at 18+.
 *
 * The return and refresh URLs are built server-side from the configured app
 * URL rather than accepted from the request, so this cannot be used as an
 * open redirect.
 */

import { authenticate, clientIp } from '@/server/auth'
import { createOnboardingLink } from '@/server/connectOnboarding'
import { hasPermission } from '@/domain/roles'
import { publicEnv } from '@/lib/env'
import { apiError, apiOk, newRequestId } from '@/lib/http'
import { supabaseAdmin } from '@/lib/supabase/admin'

export async function POST(req: Request): Promise<Response> {
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

  const base = publicEnv().NEXT_PUBLIC_APP_URL.replace(/\/$/, '')

  const result = await createOnboardingLink({
    db: supabaseAdmin(),
    providerUserId: auth.auth.userId,
    returnUrl: `${base}/payouts/complete`,
    refreshUrl: `${base}/payouts/start`,
    now: new Date(),
    ip: clientIp(req),
  })

  if (!result.ok) {
    switch (result.code) {
      case 'NO_PROVIDER_PROFILE':
        return apiError(result.code, 'Complete provider onboarding first.', 409, { requestId })
      case 'PROVIDER_INELIGIBLE':
        return apiError(result.code, 'This account is not eligible to provide services.', 403, {
          requestId,
        })
      case 'GUARDIAN_NOT_LINKED':
        return apiError(
          result.code,
          'A guardian needs to accept their invitation before payouts can be set up.',
          409,
          { requestId },
        )
      default:
        return apiError('INTERNAL_ERROR', 'Something went wrong. Please try again.', 500, {
          requestId,
        })
    }
  }

  return apiOk({
    url: result.url,
    expiresAt: result.expiresAt,
    // Tells the UI whose task this is, so a minor sees "ask your guardian to
    // finish this" rather than a form they cannot legally complete.
    completedBy: result.holder === 'guardian' ? 'guardian' : 'provider',
  })
}
