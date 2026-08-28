'use client'

/**
 * Customer checkout, in three steps on one page.
 *
 * Address, then what it costs, then the card. PRD section 10 puts
 * eligibility before anything else, and that ordering is not cosmetic: a
 * customer who cannot be served should never reach a price, and nobody
 * should reach a card field before seeing the total.
 *
 * ## Card details never touch this application
 *
 * Stripe.js is loaded from js.stripe.com and mounts an iframe owned by
 * Stripe. The number, expiry and CVC are entered inside that frame, and
 * this code only ever sees the payment-method reference Stripe hands back.
 * That is a PCI requirement rather than a preference -- Stripe.js must be
 * loaded from their domain, never bundled, which is also why there is no
 * npm dependency here.
 *
 * ## The subscription exists before the card does
 *
 * Step 2 creates it as `pending` and takes no money. An abandoned checkout
 * therefore leaves a row nobody is charged for and no stranger on a
 * teenager's route, and the customer can come back to a card form without
 * re-entering an address.
 */

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Alert, Field } from '@/components/ui'
import { CUSTOMER_ATTESTATION } from '@/domain/consent'

type Preview = {
  business: { name: string; slug: string }
  serviceName: string
  eligible: boolean
  atCapacity: boolean
  normalizedAddress: string
  price: { cents: number; unit: string }
  billing: {
    cycleWeeks: number
    occurrences: number
    serviceSubtotalCents: number
    platformFeeCents: number
    totalCents: number
    minimumFeeApplied: boolean
  }
  earliestStartDate: string | null
  firstCycleDates: string[]
}

type Stage =
  | { name: 'address' }
  | { name: 'review'; preview: Preview }
  | { name: 'pay'; subscriptionId: string; clientSecret: string; totalCents: number }
  | { name: 'done'; chargedCents: number }

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`

/** Loads Stripe.js once, from Stripe's domain. Never bundled. */
function useStripeJs(): boolean {
  const [ready, setReady] = useState(
    () => typeof window !== 'undefined' && Boolean((window as { Stripe?: unknown }).Stripe),
  )

  useEffect(() => {
    if (ready) return
    const existing = document.querySelector<HTMLScriptElement>('script[data-stripe-js]')
    if (existing) {
      existing.addEventListener('load', () => setReady(true), { once: true })
      return
    }
    const script = document.createElement('script')
    script.src = 'https://js.stripe.com/v3/'
    script.async = true
    script.dataset['stripeJs'] = 'true'
    script.addEventListener('load', () => setReady(true), { once: true })
    document.head.appendChild(script)
  }, [ready])

  return ready
}

export function Checkout({ serviceId }: { serviceId: string }) {
  const router = useRouter()
  const [stage, setStage] = useState<Stage>({ name: 'address' })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [line1, setLine1] = useState('')
  const [city, setCity] = useState('')
  const [region, setRegion] = useState('')
  const [postalCode, setPostalCode] = useState('')
  const [instructions, setInstructions] = useState('')
  const [referralCode, setReferralCode] = useState('')
  const [acknowledged, setAcknowledged] = useState<string[]>([])
  const [typedName, setTypedName] = useState('')

  const allAcknowledged = CUSTOMER_ATTESTATION.items.every((i) => acknowledged.includes(i.key))
  const signatureLooksReal = typedName.trim().length >= 3

  const address = { line1, city, region, postalCode, countryCode: 'US' }

  async function post(url: string, body: unknown, method = 'POST') {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const parsed = await res.json().catch(() => ({}))
    return { ok: res.ok, body: parsed as Record<string, never> }
  }

  async function checkAddress(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const { ok, body } = await post('/api/v1/checkout/preview', {
        providerServiceId: serviceId,
        address,
      })
      if (!ok) {
        setError(
          (body as { error?: { message?: string } }).error?.message ??
            'We could not check that address.',
        )
        return
      }
      setStage({ name: 'review', preview: body as unknown as Preview })
    } catch {
      setError('We could not reach the server. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  async function confirm() {
    setError(null)
    setBusy(true)
    try {
      const created = await post('/api/v1/subscriptions', {
        providerServiceId: serviceId,
        address,
        attestation: { acknowledgedItems: acknowledged, typedName },
        ...(instructions.trim() ? { customerInstructions: instructions.trim() } : {}),
        ...(referralCode.trim() ? { referralCode: referralCode.trim() } : {}),
      })
      if (!created.ok) {
        setError(
          (created.body as { error?: { message?: string } }).error?.message ??
            'We could not set that up.',
        )
        return
      }

      const subscriptionId = (created.body as unknown as { subscriptionId: string }).subscriptionId
      const totalCents = (created.body as unknown as { billing: { totalCents: number } }).billing
        .totalCents

      const setup = await post(`/api/v1/subscriptions/${subscriptionId}/payment`, {})
      if (!setup.ok) {
        setError(
          (setup.body as { error?: { message?: string } }).error?.message ??
            'We could not start payment.',
        )
        return
      }

      setStage({
        name: 'pay',
        subscriptionId,
        clientSecret: (setup.body as unknown as { clientSecret: string }).clientSecret,
        totalCents,
      })
    } catch {
      setError('We could not reach the server. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  if (stage.name === 'done') {
    return (
      <div className="stack">
        <Alert kind="success">You are subscribed. {money(stage.chargedCents)} was charged.</Alert>
        <p className="muted" style={{ marginBottom: 0 }}>
          You can pause, skip a visit or cancel at any time from your account.
        </p>
        <button className="btn btn--full" type="button" onClick={() => router.push('/account')}>
          Go to my account
        </button>
      </div>
    )
  }

  if (stage.name === 'pay') {
    return (
      <PayStep
        subscriptionId={stage.subscriptionId}
        clientSecret={stage.clientSecret}
        totalCents={stage.totalCents}
        onDone={(chargedCents) => setStage({ name: 'done', chargedCents })}
      />
    )
  }

  if (stage.name === 'review') {
    const p = stage.preview

    if (!p.eligible) {
      return (
        <div className="stack">
          <Alert kind="error">
            {p.business.name} does not cover {p.normalizedAddress} yet.
          </Alert>
          <button
            className="btn btn--secondary btn--full"
            type="button"
            onClick={() => setStage({ name: 'address' })}
          >
            Try another address
          </button>
        </div>
      )
    }

    if (p.atCapacity) {
      return (
        <div className="stack">
          {/* A full route is a normal state, not a failure. PRD section 14
              makes filling a route before widening it the growth mechanic. */}
          <Alert kind="info">
            This round is full right now. {p.business.name} is not taking new houses until a spot
            opens.
          </Alert>
        </div>
      )
    }

    return (
      <div className="stack">
        {error ? <Alert kind="error">{error}</Alert> : null}

        <div>
          <h2>{p.serviceName}</h2>
          <p className="muted small" style={{ marginBottom: 0 }}>
            {p.normalizedAddress}
          </p>
        </div>

        <dl className="ledger">
          <div className="ledger__row">
            <dt>
              {p.billing.occurrences} visit{p.billing.occurrences === 1 ? '' : 's'} at{' '}
              {money(p.price.cents)}
            </dt>
            <dd>{money(p.billing.serviceSubtotalCents)}</dd>
          </div>
          <div className="ledger__row">
            {/* Named, not folded into the total. The provider keeps their
                listed price and this is what pays for the platform. */}
            <dt>
              Platform fee{p.billing.minimumFeeApplied ? ' (minimum)' : ''}
              <span className="muted small"> — the provider keeps their full price</span>
            </dt>
            <dd>{money(p.billing.platformFeeCents)}</dd>
          </div>
          <div className="ledger__row ledger__row--total">
            <dt>Every {p.billing.cycleWeeks} weeks</dt>
            <dd>{money(p.billing.totalCents)}</dd>
          </div>
        </dl>

        {p.firstCycleDates.length > 0 ? (
          <p className="small muted">
            First visits: {p.firstCycleDates.slice(0, 4).join(', ')}
            {p.firstCycleDates.length > 4 ? '...' : ''}
          </p>
        ) : null}

        <Field
          label="Anything they should know? (optional)"
          name="instructions"
          hint="Where the bins live, which gate to use. Kept between you and them."
          maxLength={500}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
        />

        <Field
          label="Referral code (optional)"
          name="referralCode"
          hint="If a neighbour gave you one."
          maxLength={16}
          value={referralCode}
          onChange={(e) => setReferralCode(e.target.value)}
        />

        {/*
          Itemized, from the legal pass. Each point is checked separately
          and the keys are stored, so "did they agree that we run no
          background checks" is answerable on its own rather than inferred
          from one boolean. The list renders from domain/consent.ts -- the
          same array that gets hashed into the signed record, so what is on
          screen and what is stored cannot drift.
        */}
        <fieldset className="attest">
          <legend className="field__label">{CUSTOMER_ATTESTATION.title}</legend>
          <p className="field__hint">{CUSTOMER_ATTESTATION.intro}</p>
          {CUSTOMER_ATTESTATION.items.map((item) => (
            <label key={item.key} className="attest__item">
              <input
                type="checkbox"
                checked={acknowledged.includes(item.key)}
                onChange={(e) =>
                  setAcknowledged((prev) =>
                    e.target.checked
                      ? [...prev, item.key]
                      : prev.filter((k) => k !== item.key),
                  )
                }
              />
              <span>{item.text}</span>
            </label>
          ))}
        </fieldset>

        <Field
          label="Type your full name to agree"
          name="typedName"
          hint={CUSTOMER_ATTESTATION.statement}
          autoComplete="name"
          value={typedName}
          onChange={(e) => setTypedName(e.target.value)}
        />

        <p className="small muted" style={{ marginBottom: 0 }}>
          Nothing is charged until you enter a card on the next step.
        </p>

        <button
          className="btn btn--full"
          type="button"
          onClick={confirm}
          disabled={busy || !allAcknowledged || !signatureLooksReal}
        >
          {busy ? 'Setting up...' : 'Continue to payment'}
        </button>
        <button
          className="btn btn--link"
          type="button"
          onClick={() => setStage({ name: 'address' })}
        >
          Use a different address
        </button>
      </div>
    )
  }

  return (
    <form className="stack" onSubmit={checkAddress} noValidate>
      {error ? <Alert kind="error">{error}</Alert> : null}

      <p className="muted" style={{ marginBottom: 0 }}>
        First, whether they come to your street.
      </p>

      <Field
        label="Street address"
        name="line1"
        autoComplete="address-line1"
        required
        value={line1}
        onChange={(e) => setLine1(e.target.value)}
      />
      <Field
        label="Town or city"
        name="city"
        autoComplete="address-level2"
        required
        value={city}
        onChange={(e) => setCity(e.target.value)}
      />
      <Field
        label="State"
        name="region"
        hint="Two letters, like TX."
        autoComplete="address-level1"
        maxLength={2}
        required
        value={region}
        onChange={(e) => setRegion(e.target.value.toUpperCase())}
      />
      <Field
        label="ZIP"
        name="postalCode"
        autoComplete="postal-code"
        required
        value={postalCode}
        onChange={(e) => setPostalCode(e.target.value)}
      />

      <button className="btn btn--full" type="submit" disabled={busy}>
        {busy ? 'Checking...' : 'Check my address'}
      </button>
    </form>
  )
}

type StripeLike = {
  elements: (options: { clientSecret: string }) => {
    create: (kind: string, options?: unknown) => { mount: (selector: string) => void }
    submit: () => Promise<{ error?: { message?: string } }>
  }
  confirmSetup: (options: {
    elements: unknown
    redirect: 'if_required'
  }) => Promise<{ error?: { message?: string }; setupIntent?: { payment_method?: string } }>
}

function PayStep({
  subscriptionId,
  clientSecret,
  totalCents,
  onDone,
}: {
  subscriptionId: string
  clientSecret: string
  totalCents: number
  onDone: (chargedCents: number) => void
}) {
  const stripeReady = useStripeJs()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const stripeRef = useRef<StripeLike | null>(null)
  const elementsRef = useRef<ReturnType<StripeLike['elements']> | null>(null)
  const mounted = useRef(false)

  useEffect(() => {
    if (!stripeReady || mounted.current) return
    const key = process.env['NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY']
    if (!key) {
      setError('Payments are not configured.')
      return
    }

    const factory = (window as unknown as { Stripe: (k: string) => StripeLike }).Stripe
    const stripe = factory(key)
    const elements = stripe.elements({ clientSecret })
    elements.create('payment').mount('#payment-element')

    stripeRef.current = stripe
    elementsRef.current = elements
    mounted.current = true
  }, [stripeReady, clientSecret])

  async function pay() {
    const stripe = stripeRef.current
    const elements = elementsRef.current
    if (!stripe || !elements) return

    setError(null)
    setBusy(true)
    try {
      const submitted = await elements.submit()
      if (submitted.error) {
        setError(submitted.error.message ?? 'Check the card details.')
        return
      }

      // redirect: 'if_required' keeps the customer here unless their bank
      // demands a 3DS challenge, which Stripe then handles itself.
      const confirmed = await stripe.confirmSetup({ elements, redirect: 'if_required' })
      if (confirmed.error) {
        setError(confirmed.error.message ?? 'That card was not accepted.')
        return
      }

      const paymentMethodRef = confirmed.setupIntent?.payment_method
      if (!paymentMethodRef) {
        setError('That card was not saved. Please try again.')
        return
      }

      const res = await fetch(`/api/v1/subscriptions/${subscriptionId}/payment`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentMethodRef }),
      })
      const body = await res.json().catch(() => ({}))

      if (!res.ok) {
        setError(body?.error?.message ?? 'We could not take payment.')
        return
      }

      onDone(body?.billing?.chargedCents ?? totalCents)
    } catch {
      setError('We could not reach the server. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="stack">
      {error ? <Alert kind="error">{error}</Alert> : null}

      <p className="muted" style={{ marginBottom: 0 }}>
        {money(totalCents)} today, then the same every cycle until you pause or cancel.
      </p>

      {/* Stripe mounts an iframe here. Card details are typed inside it and
          never reach this application. */}
      <div id="payment-element" />

      {!stripeReady ? <p className="small muted">Loading the card form...</p> : null}

      <button className="btn btn--full" type="button" onClick={pay} disabled={busy || !stripeReady}>
        {busy ? 'Paying...' : `Pay ${money(totalCents)}`}
      </button>

      <p className="small muted" style={{ marginBottom: 0 }}>
        Card details go straight to Stripe. Count On Local never sees or stores your card number.
      </p>
    </div>
  )
}
