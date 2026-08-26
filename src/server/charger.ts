/**
 * The payment processor boundary.
 *
 * Same arrangement as the geocoder: an interface, a real implementation, a
 * stub, and a setter so tests can swap one in. Settlement runs against the
 * interface, so the money rules can be exercised end to end without a
 * network call to Stripe.
 *
 * TECHNICAL_SPEC section 6 keeps domain records processor-agnostic, and
 * CLAUDE.md rule 6 says Stripe is never the source of truth for scheduling.
 * This is where that line sits: everything above it speaks in cents and
 * idempotency keys, and only the implementation below knows what a
 * PaymentIntent is.
 */

import { stripe } from '@/lib/stripe'

export type ChargeRequest = {
  amountCents: number
  currency: string
  /** Processor-side customer, e.g. a Stripe customer id. */
  customerRef: string
  /** Processor-side payment method. */
  paymentMethodRef: string
  /**
   * Required. TECHNICAL_SPEC section 11: every payment-changing operation
   * carries one, so a retried settlement cannot bill a card twice.
   */
  idempotencyKey: string
  description: string
}

export type ChargeResult =
  | { ok: true; processor: string; externalId: string }
  /** The card said no. A real answer, not a fault -- do not retry blindly. */
  | { ok: false; code: 'declined'; processor: string; externalId?: string; message: string }
  /** Something broke. Safe to retry with the same key. */
  | { ok: false; code: 'error'; processor: string; message: string }

export type RefundRequest = {
  amountCents: number
  /** The processor charge being refunded against. */
  externalChargeId: string
  idempotencyKey: string
  reason: string
}

export type RefundResult =
  | { ok: true; processor: string; externalId: string }
  | { ok: false; processor: string; message: string }

export interface Charger {
  charge(request: ChargeRequest): Promise<ChargeResult>
  /**
   * Hands money back. PRD section 12: when a subscription ends before its
   * credit is spent, "the balance is refundable".
   */
  refund(request: RefundRequest): Promise<RefundResult>
}

export class StripeCharger implements Charger {
  async charge(request: ChargeRequest): Promise<ChargeResult> {
    try {
      const intent = await stripe().paymentIntents.create(
        {
          amount: request.amountCents,
          currency: request.currency.toLowerCase(),
          customer: request.customerRef,
          payment_method: request.paymentMethodRef,
          description: request.description,
          // Off-session: the customer is not present when a cycle renews.
          confirm: true,
          off_session: true,
        },
        { idempotencyKey: request.idempotencyKey },
      )

      if (intent.status === 'succeeded') {
        return { ok: true, processor: 'stripe', externalId: intent.id }
      }

      // requires_action, requires_payment_method and friends all mean the
      // money did not move. Treated as declined rather than as an error,
      // because retrying the same call will not change the answer.
      return {
        ok: false,
        code: 'declined',
        processor: 'stripe',
        externalId: intent.id,
        message: `Payment not completed (${intent.status}).`,
      }
    } catch (err) {
      const e = err as { type?: string; code?: string; message?: string; payment_intent?: { id?: string } }

      if (e.type === 'StripeCardError') {
        return {
          ok: false,
          code: 'declined',
          processor: 'stripe',
          ...(e.payment_intent?.id ? { externalId: e.payment_intent.id } : {}),
          message: e.message ?? 'The card was declined.',
        }
      }

      return {
        ok: false,
        code: 'error',
        processor: 'stripe',
        message: e.message ?? 'Payment processor unavailable.',
      }
    }
  }

  async refund(request: RefundRequest): Promise<RefundResult> {
    try {
      const refund = await stripe().refunds.create(
        {
          payment_intent: request.externalChargeId,
          amount: request.amountCents,
          metadata: { reason: request.reason },
        },
        { idempotencyKey: request.idempotencyKey },
      )
      return { ok: true, processor: 'stripe', externalId: refund.id }
    } catch (err) {
      const e = err as { message?: string }
      return {
        ok: false,
        processor: 'stripe',
        message: e.message ?? 'Refund could not be processed.',
      }
    }
  }
}

/**
 * Records what it was asked to do and answers however the test says.
 *
 * Keeps every request so a test can assert the idempotency key and the
 * amount, which are the two things worth getting wrong quietly.
 */
export class StubCharger implements Charger {
  readonly refunds: RefundRequest[] = []
  private refundOutcome: RefundResult | undefined

  readonly requests: ChargeRequest[] = []
  private outcome: ChargeResult | ((r: ChargeRequest) => ChargeResult)

  constructor(outcome?: ChargeResult | ((r: ChargeRequest) => ChargeResult)) {
    this.outcome =
      outcome ??
      ((r) => ({ ok: true, processor: 'stub', externalId: `pi_stub_${r.idempotencyKey}` }))
  }

  setOutcome(outcome: ChargeResult | ((r: ChargeRequest) => ChargeResult)): void {
    this.outcome = outcome
  }

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    this.requests.push(request)
    return typeof this.outcome === 'function' ? this.outcome(request) : this.outcome
  }

  setRefundOutcome(outcome: RefundResult): void {
    this.refundOutcome = outcome
  }

  async refund(request: RefundRequest): Promise<RefundResult> {
    this.refunds.push(request)
    return (
      this.refundOutcome ?? {
        ok: true,
        processor: 'stub',
        externalId: `re_stub_${request.idempotencyKey}`,
      }
    )
  }

  /** Requests seen for one idempotency key. Should never exceed one. */
  countFor(idempotencyKey: string): number {
    return this.requests.filter((r) => r.idempotencyKey === idempotencyKey).length
  }
}

let current: Charger | undefined

export function getCharger(): Charger {
  if (!current) current = new StripeCharger()
  return current
}

export function setCharger(c: Charger): void {
  current = c
}
