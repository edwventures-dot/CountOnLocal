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

export type EnsureCustomerRequest = {
  /** Our own user id. Goes into processor metadata, nothing more. */
  userRef: string
  idempotencyKey: string
}

export type EnsureCustomerResult =
  | { ok: true; processor: string; customerRef: string }
  | { ok: false; processor: string; message: string }

export type SetupIntentRequest = {
  customerRef: string
  idempotencyKey: string
}

export type SetupIntentResult =
  | {
      ok: true
      processor: string
      externalId: string
      /**
       * Handed to the browser, which confirms the card directly with the
       * processor. Card details never reach this server, which is the
       * entire point of doing it this way rather than accepting a number.
       */
      clientSecret: string
    }
  | { ok: false; processor: string; message: string }

export type TransferRequest = {
  amountCents: number
  currency: string
  /** The connected account the money is going to. */
  destinationRef: string
  idempotencyKey: string
  description: string
}

export type TransferResult =
  | { ok: true; processor: string; externalId: string }
  /**
   * The platform has not got the money yet. Card payments take days to
   * settle, and a transfer against an unsettled balance is a normal
   * condition rather than a fault -- retry when it has landed.
   */
  | { ok: false; code: 'insufficient_funds'; processor: string; message: string }
  | { ok: false; code: 'error'; processor: string; message: string }

export interface Charger {
  charge(request: ChargeRequest): Promise<ChargeResult>
  /**
   * A processor-side customer to hang payment methods off.
   *
   * Carries our user id as metadata and nothing else -- no email, no name.
   * The processor does not need to know who this person is to hold a card
   * for them, and TECHNICAL_SPEC section 17's rule about what leaves the
   * building does not stop applying because the recipient is Stripe.
   */
  ensureCustomer(request: EnsureCustomerRequest): Promise<EnsureCustomerResult>
  /**
   * Starts card collection. The browser confirms against the returned
   * secret, so no card number, CVC or expiry ever touches this server.
   */
  createSetupIntent(request: SetupIntentRequest): Promise<SetupIntentResult>
  /**
   * Hands money back. PRD section 12: when a subscription ends before its
   * credit is spent, "the balance is refundable".
   */
  refund(request: RefundRequest): Promise<RefundResult>
  /**
   * Moves earned money to a provider's connected account.
   *
   * A Connect transfer, not a bank payout. Stripe then pays the connected
   * account out to its bank on its own schedule -- that second leg is
   * theirs to run and is not something this application controls or
   * should pretend to.
   */
  transfer(request: TransferRequest): Promise<TransferResult>
}

export class StripeCharger implements Charger {
  async ensureCustomer(request: EnsureCustomerRequest): Promise<EnsureCustomerResult> {
    try {
      const customer = await stripe().customers.create(
        { metadata: { app_user_id: request.userRef } },
        { idempotencyKey: request.idempotencyKey },
      )
      return { ok: true, processor: 'stripe', customerRef: customer.id }
    } catch (err) {
      const e = err as { message?: string }
      return { ok: false, processor: 'stripe', message: e.message ?? 'Could not create a customer.' }
    }
  }

  async createSetupIntent(request: SetupIntentRequest): Promise<SetupIntentResult> {
    try {
      const intent = await stripe().setupIntents.create(
        {
          customer: request.customerRef,
          // The card is kept to charge later, when nobody is at the
          // keyboard. Declaring that here is what lets the renewal charge
          // run off-session without a fresh authorisation.
          usage: 'off_session',
        },
        { idempotencyKey: request.idempotencyKey },
      )

      if (!intent.client_secret) {
        return { ok: false, processor: 'stripe', message: 'Setup intent returned no client secret.' }
      }

      return {
        ok: true,
        processor: 'stripe',
        externalId: intent.id,
        clientSecret: intent.client_secret,
      }
    } catch (err) {
      const e = err as { message?: string }
      return { ok: false, processor: 'stripe', message: e.message ?? 'Could not start card setup.' }
    }
  }

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

  async transfer(request: TransferRequest): Promise<TransferResult> {
    try {
      const transfer = await stripe().transfers.create(
        {
          amount: request.amountCents,
          currency: request.currency.toLowerCase(),
          destination: request.destinationRef,
          description: request.description,
        },
        { idempotencyKey: request.idempotencyKey },
      )
      return { ok: true, processor: 'stripe', externalId: transfer.id }
    } catch (err) {
      const e = err as { code?: string; message?: string }

      // Told apart because they mean different things to the operator: an
      // unsettled balance resolves itself in a day, and everything else
      // needs somebody to look.
      if (e.code === 'balance_insufficient') {
        return {
          ok: false,
          code: 'insufficient_funds',
          processor: 'stripe',
          message: 'Waiting for card payments to settle.',
        }
      }

      return {
        ok: false,
        code: 'error',
        processor: 'stripe',
        message: e.message ?? 'Transfer failed.',
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
  readonly customers: EnsureCustomerRequest[] = []
  readonly setups: SetupIntentRequest[] = []
  private setupOutcome: SetupIntentResult | undefined

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

  setSetupOutcome(outcome: SetupIntentResult): void {
    this.setupOutcome = outcome
  }

  async ensureCustomer(request: EnsureCustomerRequest): Promise<EnsureCustomerResult> {
    this.customers.push(request)
    return { ok: true, processor: 'stub', customerRef: `cus_stub_${request.userRef}` }
  }

  async createSetupIntent(request: SetupIntentRequest): Promise<SetupIntentResult> {
    this.setups.push(request)
    return (
      this.setupOutcome ?? {
        ok: true,
        processor: 'stub',
        externalId: `seti_stub_${request.idempotencyKey}`,
        clientSecret: `seti_stub_${request.idempotencyKey}_secret`,
      }
    )
  }

  readonly transfers: TransferRequest[] = []
  private transferOutcome: TransferResult | undefined

  setTransferOutcome(outcome: TransferResult): void {
    this.transferOutcome = outcome
  }

  async transfer(request: TransferRequest): Promise<TransferResult> {
    this.transfers.push(request)
    return (
      this.transferOutcome ?? {
        ok: true,
        processor: 'stub',
        externalId: `tr_stub_${request.idempotencyKey}`,
      }
    )
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
