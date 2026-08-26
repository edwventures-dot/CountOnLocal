/**
 * POST /v1/subscriptions
 *
 * API_CONTRACT: "Creates subscription and initial processor setup/charge
 * flow."
 *
 * This creates the subscription in `pending` and generates the first cycle
 * of occurrences. It does not charge anything: the payment step attaches a
 * method and settles the first cycle, and until that happens no stranger
 * has been added to a teenager's route.
 */

import { guard, parseJson, fieldErrorsFrom } from '@/app/api/v1/_shared'
import { createSubscription, createSubscriptionSchema } from '@/server/checkoutService'
import { apiError, apiOk } from '@/lib/http'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { clientIp } from '@/server/auth'
import { track } from '@/server/analytics'

export async function POST(req: Request): Promise<Response> {
  const g = await guard('subscription:create')
  if (!g.ok) return g.response
  const { auth, requestId } = g

  const parsedBody = await parseJson(req)
  if (!parsedBody.ok) {
    return apiError('INVALID_JSON', 'Request body must be JSON.', 400, { requestId })
  }

  const parsed = createSubscriptionSchema.safeParse(parsedBody.body)
  if (!parsed.success) {
    return apiError('VALIDATION_FAILED', 'Check the highlighted fields.', 400, {
      requestId,
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    })
  }

  const result = await createSubscription({
    db: supabaseAdmin(),
    customerUserId: auth.userId,
    input: parsed.data,
    now: new Date(),
    ip: clientIp(req),
  })

  if (result.ok) {
    track({
      event: 'subscription_started',
      userId: auth.userId,
      properties: {
        subscription_id: result.subscriptionId,
        subscription_state: result.state,
        occurrence_count: result.occurrenceCount,
        price_cents: result.quote.serviceSubtotalCents,
        platform_fee_cents: result.quote.platformFeeCents,
      },
    })
  } else if (result.code === 'AT_CAPACITY') {
    // Worth counting separately from other failures. A full route is the
    // signal PRD section 14's density prompt exists to act on, and the
    // funnel needs to distinguish "nobody wanted it" from "we turned them
    // away".
    track({ event: 'checkout_started', userId: auth.userId, properties: { at_capacity: true } })
  }

  if (!result.ok) {
    switch (result.code) {
      case 'SERVICE_NOT_FOUND':
      case 'NO_SCHEDULE':
        return apiError('NOT_FOUND', 'That service was not found.', 404, { requestId })
      case 'NOT_ELIGIBLE':
        return apiError(result.code, 'This address is outside the current service area.', 422, { requestId })
      case 'AT_CAPACITY':
        // A full route is a normal state, not a failure. PRD section 14
        // makes filling a route before widening it the growth mechanic.
        return apiError(result.code, 'This route is full right now. Ask to be told when a spot opens.', 409, { requestId })
      case 'ALREADY_SUBSCRIBED':
        return apiError(result.code, 'You already have this service at that address.', 409, { requestId })
      case 'INVALID_START_DATE':
        return apiError(result.code, 'Choose one of the offered start dates.', 422, { requestId })
      case 'ADDRESS_NOT_FOUND':
      case 'ADDRESS_AMBIGUOUS':
      case 'UNSUPPORTED_COUNTRY':
        return apiError(result.code, 'We could not use that address.', 422, { requestId })
      default:
        return apiError('INTERNAL_ERROR', 'Something went wrong. Please try again.', 500, { requestId })
    }
  }

  return apiOk(
    {
      subscriptionId: result.subscriptionId,
      state: result.state,
      startDate: result.startDate,
      occurrenceCount: result.occurrenceCount,
      billing: {
        serviceSubtotalCents: result.quote.serviceSubtotalCents,
        platformFeeCents: result.quote.platformFeeCents,
        totalCents: result.quote.customerTotalCents,
      },
      // The next step is attaching a payment method. Until then nothing is
      // charged and the provider has not been committed to anything.
      nextStage: 'payment_method',
    },
    201,
  )
}
