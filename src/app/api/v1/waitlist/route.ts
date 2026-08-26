/**
 * POST /v1/waitlist
 *
 * The only writer to waitlist_signups. The table has row level security on
 * with no policies at all, so nothing reaches it except the service role --
 * which means this handler is the door, and it validates before opening.
 *
 * Deliberately NOT audit-logged. The audit log exists for sensitive actions
 * against real records (SAFETY_TRUST_POLICY section 15, CLAUDE.md rule 9);
 * writing every marketing signup into it would bury the guardian
 * revocations and payout holds it is meant to make findable.
 */

import { supabaseAdmin } from '@/lib/supabase/admin'
import { apiError, apiOk, newRequestId } from '@/lib/http'
import { validateWaitlistSignup } from '@/domain/waitlist'

export async function POST(request: Request): Promise<Response> {
  const requestId = newRequestId()

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return apiError('invalid_body', 'Send a JSON body.', 400, { requestId })
  }

  const parsed = validateWaitlistSignup((body ?? {}) as Record<string, unknown>)
  if (!parsed.ok) {
    return apiError('validation_failed', 'Check the highlighted fields.', 422, {
      requestId,
      fieldErrors: parsed.fieldErrors,
    })
  }

  const { email, role, postalCode } = parsed.value

  const { error } = await supabaseAdmin()
    .from('waitlist_signups')
    .upsert(
      { email, role, postal_code: postalCode },
      // Signing up twice is a no-op, not an error. Telling someone "you are
      // already on the list" would also confirm to a stranger that a given
      // address is on it, so both paths return the same thing.
      { onConflict: 'email,role', ignoreDuplicates: true },
    )

  if (error) {
    // The message may name the column or constraint; that belongs in logs,
    // not in a response. The request id is how support ties the two together.
    console.error('[waitlist] insert failed', { requestId, code: error.code })
    return apiError('waitlist_unavailable', 'Could not save that right now. Try again shortly.', 503, {
      requestId,
    })
  }

  return apiOk({ joined: true, role }, 201)
}
