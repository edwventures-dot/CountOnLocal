/**
 * GET  /api/v1/account/close   what closing would actually do
 * POST /api/v1/account/close   do it
 *
 * ## Why GET exists
 *
 * Because the honest answer is complicated, and a confirmation dialog that
 * says "this cannot be undone" while quietly retaining seven years of
 * ledger and audit rows is a lie of exactly the kind this product refuses
 * everywhere else.
 *
 * GET returns the same structure the job acts on -- what is erased now,
 * what is kept, for how long, and the reason for each. The page that asks
 * "are you sure" and the code that carries it out therefore cannot drift
 * apart, because they read the same table in src/domain/retention.ts.
 *
 * ## Why this is not a DELETE
 *
 * Nothing is deleted. `consent_records.signer_user_id`,
 * `completion_photos.uploaded_by_user_id` and the incident references are
 * `on delete restrict`, so the user row physically cannot go once somebody
 * has signed a consent, uploaded a photo, or been named in a report. What
 * happens is de-identification, and calling the endpoint DELETE would
 * promise something the database will not do.
 */

import { authenticate, clientIp } from '@/server/auth'
import { closeAccount } from '@/server/retentionJob'
import { deletionEffect, RETENTION } from '@/domain/retention'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { apiError, apiOk, newRequestId } from '@/lib/http'

export const dynamic = 'force-dynamic'

/** The policy, rendered for a person rather than for a job. */
function explain() {
  const effect = deletionEffect()
  return {
    erasedImmediately: effect.erasedNow.map((c) => ({
      what: c,
      clock: RETENTION[c].clock,
    })),
    keptForNow: effect.retained.map((r) => ({
      what: r.class,
      forDays: r.days,
      because: r.because,
      clock: RETENTION[r.class].clock,
    })),
    // Said plainly rather than left for somebody to infer from the shape.
    summary:
      'Your contact details and display name are replaced straight away, and so is anything with no reason to be kept. Financial and safety records stay for their retention period: they are the record of money that moved and of decisions made, and neither can be rewritten on request.',
  }
}

export async function GET(): Promise<Response> {
  const requestId = newRequestId()

  const auth = await authenticate()
  if (!auth.ok) return apiError('UNAUTHENTICATED', 'Sign in to continue.', 401, { requestId })

  return apiOk({ requestId, effect: explain() })
}

export async function POST(request: Request): Promise<Response> {
  const requestId = newRequestId()

  const auth = await authenticate()
  if (!auth.ok) return apiError('UNAUTHENTICATED', 'Sign in to continue.', 401, { requestId })

  let payload: Record<string, unknown> = {}
  try {
    payload = (await request.json()) as Record<string, unknown>
  } catch {
    // A body is optional here. Closing an account needs no arguments.
  }

  const reason = typeof payload['reason'] === 'string' ? payload['reason'].slice(0, 500) : ''

  // Always the account holder's own. There is no userId in the payload on
  // purpose: an endpoint that closes an account by id is an endpoint that
  // closes somebody else's account by id, and staff-initiated closure
  // belongs in the admin console with its own authorization and audit.
  const result = await closeAccount({
    db: supabaseAdmin(),
    userId: auth.auth.userId,
    actorUserId: auth.auth.userId,
    actorRole: 'self',
    reason,
    now: new Date(),
    ip: clientIp(request) ?? undefined,
  })

  if (!result.ok) {
    // 409, not 400. Nothing about the request is malformed -- the account
    // is in a state that has to be resolved first, and the message says
    // which one and what to do about it.
    const status = result.code === 'NOT_FOUND' ? 404 : 409
    return apiError(result.code, result.message, status, { requestId })
  }

  return apiOk({ requestId, closed: true, effect: explain() })
}
