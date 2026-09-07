'use client'

/**
 * Agreeing to a standing arrangement with a neighbour.
 *
 * This replaces Checkout, which was 838 lines and mostly about money: a
 * Stripe payment element, a SetupIntent whose idempotent replay returned a
 * stale status, a card step, a pay step, a cycle quote with a platform fee
 * and an effective rate, and the recovery path for a subscription that
 * existed but had never been paid for. None of that has anywhere to go now.
 *
 * What is left is the part that was always the product: is this address on
 * the route, what is the provider being asked to do, and has the customer
 * actually read what they are agreeing to.
 *
 * ## Two steps, not four
 *
 *   1. address -- confirm where, and whether it is covered
 *   2. review  -- what the service is, what it costs, the attestation
 *
 * The address is usually already known. The storefront's own check hands it
 * over through sessionStorage rather than the URL, because a home address
 * in a query string ends up in history, in a referrer header and in every
 * log that records a path. See lib/addressHandoff.
 *
 * ## The attestation is the point of the second step
 *
 * It is itemised rather than a single box, and the keys are stored, so
 * "they agreed" can be answered per point years later. One of those points
 * is that Count On Local does not take the payment -- which is the single
 * most important thing a customer can misunderstand about this product,
 * because everything they have used before does.
 */

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { CONSENT_DOCUMENTS } from '@/domain/consent'
import { BITE_HISTORY, DOG_SIZES, requiresDogDetails } from '@/domain/serviceDetails'
import { takeAddress } from '@/lib/addressHandoff'
import { Alert, Field } from '@/components/ui'
import { SlowNotice, Spinner } from '@/components/SlowNotice'

type Preview = {
  business: { name: string; slug: string }
  serviceName: string
  eligible: boolean
  atCapacity: boolean
  normalizedAddress: string
  price: { cents: number; unit: 'week' | 'visit' | 'month' }
  schedule: { cycleWeeks: number }
  earliestStartDate: string | null
  firstCycleDates: string[]
}

type Stage = { name: 'address' } | { name: 'review'; preview: Preview }

const DOC = CONSENT_DOCUMENTS.customer_attestation

async function post(url: string, body: unknown) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { ok: res.ok, body: await res.json().catch(() => ({})) }
}

function money(cents: number, unit: string): string {
  const dollars = (cents / 100).toFixed(2).replace(/\.00$/, '')
  return `$${dollars} per ${unit === 'week' ? 'week' : unit === 'visit' ? 'visit' : 'month'}`
}

export function Subscribe({
  serviceId,
  serviceCatalogHint,
}: {
  serviceId: string
  serviceCatalogHint: string
}) {
  const router = useRouter()
  const [stage, setStage] = useState<Stage>({ name: 'address' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  const [line1, setLine1] = useState('')
  const [city, setCity] = useState('')
  const [region, setRegion] = useState('')
  const [postalCode, setPostalCode] = useState('')

  const [acknowledged, setAcknowledged] = useState<string[]>([])
  const [typedName, setTypedName] = useState('')
  const [instructions, setInstructions] = useState('')

  const needsDog = requiresDogDetails(serviceCatalogHint)
  const [dogName, setDogName] = useState('')
  const [dogSize, setDogSize] = useState<string>('medium')
  const [dogRestraint, setDogRestraint] = useState('')
  const [dogBite, setDogBite] = useState<string>('none')

  // Taken once, on mount, and removed as it is read. A customer who checked
  // one address, wandered off and came back for a different house should be
  // asked rather than silently given the old one.
  useEffect(() => {
    const carried = takeAddress(serviceId)
    if (!carried) return
    setLine1(carried.line1)
    setCity(carried.city)
    setRegion(carried.region)
    setPostalCode(carried.postalCode)
  }, [serviceId])

  const address = useMemo(
    () => ({ line1, city, region, postalCode, countryCode: 'US' }),
    [line1, city, region, postalCode],
  )

  const complete = DOC.items.every((i) => acknowledged.includes(i.key))

  async function check(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setFieldErrors({})
    setBusy(true)
    try {
      const { ok, body } = await post('/api/v1/subscribe/preview', {
        providerServiceId: serviceId,
        address,
      })
      if (!ok) {
        const err = (body as { error?: { message?: string; fieldErrors?: Record<string, string> } })
          .error
        setError(err?.message ?? 'We could not check that address.')
        setFieldErrors(err?.fieldErrors ?? {})
        return
      }
      setStage({ name: 'review', preview: (body as { data?: Preview }).data ?? (body as Preview) })
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
        ...(needsDog
          ? {
              serviceDetails: {
                dog: {
                  name: dogName,
                  size: dogSize,
                  restraint: dogRestraint,
                  biteHistory: dogBite,
                },
              },
            }
          : {}),
        ...(instructions.trim() ? { customerInstructions: instructions.trim() } : {}),
      })
      if (!created.ok) {
        setError(
          (created.body as { error?: { message?: string } }).error?.message ??
            'We could not set that up.',
        )
        return
      }
      router.refresh()
      router.push('/subscriptions')
    } catch {
      setError('We could not reach the server. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  if (stage.name === 'address') {
    return (
      <form onSubmit={check} className="stack" noValidate>
        {error ? <Alert kind="error">{error}</Alert> : null}
        <p className="muted">Where should they come?</p>

        <Field
          label="Street address"
          name="line1"
          required
          value={line1}
          error={fieldErrors['address.line1']}
          onChange={(e) => setLine1(e.target.value)}
        />
        <Field
          label="Town or city"
          name="city"
          required
          value={city}
          error={fieldErrors['address.city']}
          onChange={(e) => setCity(e.target.value)}
        />
        <Field
          label="State"
          name="region"
          maxLength={2}
          required
          hint="Two letters, like TX."
          value={region}
          error={fieldErrors['address.region']}
          onChange={(e) => setRegion(e.target.value.toUpperCase())}
        />
        <Field
          label="ZIP code"
          name="postalCode"
          required
          value={postalCode}
          error={fieldErrors['address.postalCode']}
          onChange={(e) => setPostalCode(e.target.value)}
        />

        <button className="btn btn--full" type="submit" disabled={busy}>
          {busy ? <Spinner /> : null} {busy ? 'Checking…' : 'Continue'}
        </button>
        <SlowNotice waiting={busy}>
          Still checking. Looking up an address can take a few seconds.
        </SlowNotice>
      </form>
    )
  }

  const p = stage.preview

  if (!p.eligible) {
    return (
      <Alert kind="info">
        That address is outside the area this provider covers. Nothing has been set up.
      </Alert>
    )
  }

  if (p.atCapacity) {
    return (
      <Alert kind="info">
        This round is full at the moment. Nothing has been set up, and the provider may open more
        space later.
      </Alert>
    )
  }

  return (
    <div className="stack">
      {error ? <Alert kind="error">{error}</Alert> : null}

      <div>
        <h2 style={{ marginBottom: '0.25rem' }}>{p.serviceName}</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          {p.business.name} · {money(p.price.cents, p.price.unit)}
        </p>
      </div>

      <p className="small muted">
        {p.normalizedAddress}{' '}
        <button
          type="button"
          className="btn btn--link"
          onClick={() => setStage({ name: 'address' })}
        >
          Change
        </button>
      </p>

      {p.firstCycleDates.length > 0 ? (
        <p className="small">
          First visits: {p.firstCycleDates.slice(0, 4).join(', ')}
          {p.firstCycleDates.length > 4 ? '…' : ''}
        </p>
      ) : null}

      {/*
        Said plainly and early, because it is the assumption everything else
        they have subscribed to has trained them into. A customer who thinks
        this app is taking the money will not pay their neighbour.
      */}
      <Alert kind="info">
        Count On Local does not take payment. You pay {p.business.name} directly — the two of you
        agree how.
      </Alert>

      {needsDog ? (
        <div className="stack">
          <h3>About your dog</h3>
          <p className="small muted">Your walker sees this before they arrive.</p>
          <Field
            label="Dog’s name"
            name="dogName"
            required
            value={dogName}
            onChange={(e) => setDogName(e.target.value)}
          />
          <label className="field">
            <span>Size</span>
            <select value={dogSize} onChange={(e) => setDogSize(e.target.value)}>
              {DOG_SIZES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <Field
            label="What are they walked on?"
            name="dogRestraint"
            hint="Harness, collar, head halter."
            required
            value={dogRestraint}
            onChange={(e) => setDogRestraint(e.target.value)}
          />
          <label className="field">
            <span>Have they ever bitten anyone?</span>
            <select value={dogBite} onChange={(e) => setDogBite(e.target.value)}>
              {BITE_HISTORY.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}

      <Field
        label="Anything they should know?"
        name="instructions"
        hint="Optional. “Bins are round the side by the gate.”"
        maxLength={500}
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
      />

      <div className="stack">
        <h3>{DOC.title}</h3>
        <p className="small muted">{DOC.intro}</p>
        {DOC.items.map((item) => (
          <label key={item.key} className="check">
            <input
              type="checkbox"
              checked={acknowledged.includes(item.key)}
              onChange={(e) =>
                setAcknowledged((prev) =>
                  e.target.checked ? [...prev, item.key] : prev.filter((k) => k !== item.key),
                )
              }
            />
            <span>{item.text}</span>
          </label>
        ))}
        <Field
          label="Type your full name to agree"
          name="typedName"
          required
          value={typedName}
          onChange={(e) => setTypedName(e.target.value)}
        />
        <p className="small muted">{DOC.statement}</p>
      </div>

      <button
        className="btn btn--full"
        type="button"
        disabled={busy || !complete || typedName.trim().length < 3}
        onClick={confirm}
      >
        {busy ? <Spinner /> : null} {busy ? 'Setting up…' : 'Start this service'}
      </button>
      <SlowNotice waiting={busy}>Still working. Setting up the schedule.</SlowNotice>
    </div>
  )
}
