/**
 * POST /v1/subscriptions/{id}/payment   start card collection
 * PUT  /v1/subscriptions/{id}/payment   pay the first cycle and go live
 *
 * API_CONTRACT describes `POST /v1/subscriptions` as creating the
 * "subscription and initial processor setup/charge flow". The
 * implementation splits that in two: creating the subscription commits
 * nothing and takes no money, and this is the step that does both.
 *
 * The split is deliberate. A pending subscription that is abandoned costs
 * nobody anything and puts no stranger on a teenager's route, whereas a
 * single endpoint that created and charged would have to decide what to do
 * with a half-finished checkout while holding a card.
 *
 * ## Two verbs, one path
 *
 * POST opens the flow: it returns a processor client secret the browser
 * confirms the card against. PUT closes it: it takes the resulting
 * payment-method reference, charges, and activates.
 *
 * Card details never come through here. The only thing this endpoint
 * accepts is an opaque processor reference -- see activationService for why
 * that boundary is where it is.
 */

import { authenticate, clientIp } from '@/server/auth'
import {
  activateSchema,
  activateSubscription,
  startCardSetup,
} from '@/server/activationService'
import { fieldErrorsFrom, parseJson } from '@/app/api/v1/_shared'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { apiError, apiOk, newRequestId } from '@/lib/http'
import { track } from '@/server/analytics'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

export async function POST(_request: Request, { params }: Params): Promise<Response> {
  const requestId = newRequestId()

  const auth = await authenticate()
  if (!auth.ok) return apiError('UNAUTHENTICATED', 'Sign in to continue.', 401, { requestId })

  const { id } = await params
  const result = await startCardSetup({
    db: supabaseAdmin(),
    subscriptionId: id,
    actorUserId: auth.auth.userId,
  })

  if (!result.ok) {
    const status =
      result.code === 'NOT_FOUND'
        ? 404
        : result.code === 'NOT_YOUR_SUBSCRIPTION'
          ? 403
          : result.code === 'NOT_PENDING'
            ? 409
            : 503
    return apiError(result.code, result.message, status, { requestId })
  }

  return apiOk({
    subscriptionId: id,
    // The browser confirms the card against this. It is scoped to one
    // setup on one customer and is useless without the publishable key,
    // which is why it is safe to hand over and the secret key never is.
    clientSecret: result.clientSecret,
    nextStage: 'confirm_card',
  })
}

export async function PUT(request: Request, { params }: Params): Promise<Response> {
  const requestId = newRequestId()

  const auth = await authenticate()
  if (!auth.ok) return apiError('UNAUTHENTICATED', 'Sign in to continue.', 401, { requestId })

  const parsedBody = await parseJson(request)
  if (!parsedBody.ok) {
    return apiError('INVALID_JSON', 'Request body must be JSON.', 400, { requestId })
  }

  const parsed = activateSchema.safeParse(parsedBody.body)
  if (!parsed.success) {
    return apiError('VALIDATION_FAILED', 'Check the highlighted fields.', 400, {
      requestId,
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    })
  }

  const { id } = await params
  const result = await activateSubscription({
    db: supabaseAdmin(),
    subscriptionId: id,
    actorUserId: auth.auth.userId,
    input: parsed.data,
    now: new Date(),
    ip: clientIp(request),
  })

  if (!result.ok) {
    switch (result.code) {
      case 'NOT_FOUND':
        return apiError('NOT_FOUND', 'That subscription was not found.', 404, { requestId })
      case 'NOT_YOUR_SUBSCRIPTION':
        return apiError(result.code, result.message, 403, { requestId })
      case 'NOT_PENDING':
      case 'AT_CAPACITY':
        return apiError(result.code, result.message, 409, { requestId })
      case 'GUARDIAN_APPROVAL_REQUIRED':
      case 'PROVIDER_NOT_ELIGIBLE':
        // 409, not 403. The caller is perfectly authorised; the service is
        // the thing that cannot take them right now.
        return apiError(result.code, result.message, 409, { requestId })
      case 'CARD_DECLINED':
        // 402. The request was fine and the subscription is still there --
        // another card will finish it.
        return apiError(result.code, result.message, 402, { requestId })
      case 'PROCESSOR_ERROR':
        return apiError(result.code, 'We could not take payment right now. Please try again.', 503, {
          requestId,
        })
      case 'QUOTE_MISMATCH':
      case 'NO_CYCLE':
        return apiError(result.code, result.message, 409, { requestId })
      default:
        return apiError('INTERNAL_ERROR', result.message, 500, { requestId })
    }
  }

  track({
    event: 'subscription_started',
    userId: auth.auth.userId,
    properties: {
      subscription_id: id,
      subscription_state: 'active',
      amount_cents: result.chargedCents,
      platform_fee_cents: result.quote.platformFeeCents,
      occurrence_count: result.quote.occurrences,
    },
  })

  return apiOk({
    subscriptionId: id,
    state: result.state,
    billing: {
      serviceSubtotalCents: result.quote.serviceSubtotalCents,
      platformFeeCents: result.quote.platformFeeCents,
      referralDiscountCents: result.referralDiscountCents,
      chargedCents: result.chargedCents,
    },
  })
}
