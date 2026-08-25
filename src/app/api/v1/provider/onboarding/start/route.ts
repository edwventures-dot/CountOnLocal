/**
 * POST /v1/provider/onboarding/start
 *
 * API_CONTRACT: "Creates provider profile and age state. Output: next
 * onboarding stage and whether guardian is required."
 */

import { authenticate, clientIp } from '@/server/auth'
import { onboardingStartSchema, startProviderOnboarding } from '@/server/providerOnboarding'
import { apiError, apiOk, DENIAL_RESPONSES, newRequestId } from '@/lib/http'
import { supabaseAdmin } from '@/lib/supabase/admin'

export async function POST(req: Request): Promise<Response> {
  const requestId = newRequestId()

  const auth = await authenticate()
  if (!auth.ok) {
    return apiError('UNAUTHENTICATED', 'Sign in to continue.', 401, { requestId })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return apiError('INVALID_JSON', 'Request body must be JSON.', 400, { requestId })
  }

  const parsed = onboardingStartSchema.safeParse(body)
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {}
    for (const issue of parsed.error.issues) {
      const key = issue.path.join('.') || 'body'
      fieldErrors[key] = issue.message
    }
    return apiError('VALIDATION_FAILED', 'Check the highlighted fields.', 400, {
      requestId,
      fieldErrors,
    })
  }

  const result = await startProviderOnboarding({
    // Privileged client: RLS grants no client write here on purpose, so the
    // server -- not the caller -- decides guardian_state from the DOB.
    db: supabaseAdmin(),
    userId: auth.auth.userId,
    input: parsed.data,
    now: new Date(),
    ip: clientIp(req),
  })

  if (!result.ok) {
    if (result.code === 'PROVIDER_INELIGIBLE') {
      const d = DENIAL_RESPONSES['PROVIDER_INELIGIBLE']!
      return apiError(result.code, d.message, d.status, { requestId })
    }
    if (result.code === 'ALREADY_ONBOARDED') {
      return apiError(result.code, 'This account already has a provider profile.', 409, {
        requestId,
      })
    }
    return apiError('INTERNAL_ERROR', 'Something went wrong. Please try again.', 500, { requestId })
  }

  return apiOk({
    nextStage: result.nextStage,
    guardianRequired: result.guardianRequired,
  })
}
