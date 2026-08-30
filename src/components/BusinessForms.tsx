'use client'

/**
 * The builder forms.
 *
 * Grouped in one file because they share a submit shape and are only ever
 * used together on /business. Each posts to an endpoint that already
 * existed and then refreshes -- the page recomputes its state from the
 * database rather than threading results back through React, so what is on
 * screen is what is stored.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Alert, Field } from '@/components/ui'
import { DEFAULT_RADIUS_METRES, describeRadius } from '@/domain/serviceArea'
import { formatCents, MAX_OCCURRENCE_PRICE_CENTS } from '@/domain/money'

/**
 * The billing cycle this form creates services on.
 *
 * Named rather than repeated as a bare 4, because it appears twice -- in
 * what is submitted and in what the provider is told they will be charging
 * -- and those two disagreeing is how a provider ends up surprised by
 * their own price.
 */
const WEEKS_PER_CYCLE = 4

type CatalogEntry = {
  code: string
  name: string
  description: string
}

const WEEKDAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const

function useSubmit() {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function send(url: string, body: unknown, method = 'POST'): Promise<boolean> {
    setError(null)
    setBusy(true)
    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const parsed = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(parsed?.error?.message ?? 'We could not save that. Please try again.')
        return false
      }
      router.refresh()
      return true
    } catch {
      setError('We could not reach the server. Please try again.')
      return false
    } finally {
      setBusy(false)
    }
  }

  return { error, busy, send }
}

export function CreateBusinessForm() {
  const { error, busy, send } = useSubmit()
  const [name, setName] = useState('')
  const [areaLabel, setAreaLabel] = useState('')
  const [tagline, setTagline] = useState('')

  return (
    <form
      className="stack"
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        void send('/api/v1/businesses', {
          name,
          publicAreaLabel: areaLabel || undefined,
          tagline: tagline || undefined,
        })
      }}
    >
      {error ? <Alert kind="error">{error}</Alert> : null}

      <Field
        label="Business name"
        name="name"
        hint="What neighbours will see. Your first name is fine."
        required
        maxLength={60}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />

      <Field
        label="Area name"
        name="areaLabel"
        // Never a street. This is the only geography a stranger sees, and
        // the provider is often a minor.
        hint="The neighbourhood or part of town you cover, not your street. Something like Oak Ridge, or near the high school."
        maxLength={80}
        value={areaLabel}
        onChange={(e) => setAreaLabel(e.target.value)}
      />

      <Field
        label="One-line promise (optional)"
        name="tagline"
        hint="For example: bins out and back every week, without you thinking about it."
        maxLength={120}
        value={tagline}
        onChange={(e) => setTagline(e.target.value)}
      />

      <button className="btn btn--full" type="submit" disabled={busy}>
        {busy ? 'Saving...' : 'Create my business'}
      </button>
    </form>
  )
}

export function AddServiceForm({
  businessId,
  catalog,
}: {
  businessId: string
  catalog: readonly CatalogEntry[]
}) {
  const { error, busy, send } = useSubmit()
  const [code, setCode] = useState(catalog[0]?.code ?? '')
  const [publicName, setPublicName] = useState('')
  const [description, setDescription] = useState('')
  const [price, setPrice] = useState('3.00')
  const [weekday, setWeekday] = useState<string>('tuesday')
  const [capacity, setCapacity] = useState('15')

  const chosen = catalog.find((c) => c.code === code)

  // The cap moved from the cycle total to a single visit on 2026-08-30, so
  // a customer is now billed several times the listed price in one go.
  // A provider typing "35" is setting up a $140 charge, and finding that
  // out from a customer's complaint would be a bad way to learn it.
  const perCycleCents = Math.round(Number(price) * 100) * WEEKS_PER_CYCLE

  return (
    <form
      className="stack"
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        void send(`/api/v1/businesses/${businessId}/services`, {
          catalogCode: code,
          publicName,
          description,
          priceCents: Math.round(Number(price) * 100),
          priceUnit: 'week',
          billingCycleWeeks: WEEKS_PER_CYCLE,
          scheduleRule: { frequency: 'weekly', weekdays: [weekday], timezone: 'America/Chicago' },
          capacityRule: { maxAddresses: Math.round(Number(capacity)) },
        })
      }}
    >
      {error ? <Alert kind="error">{error}</Alert> : null}

      <label className="field">
        <span className="field__label">What are you offering?</span>
        {/* Server-owned list. A provider picks from it and cannot add to
            it, and the free text below cannot widen it. CLAUDE.md rule 3. */}
        <span className="field__hint">
          Chosen from the services Count On Local allows. You cannot invent a new one.
        </span>
        <select
          className="field__input"
          name="catalogCode"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        >
          {catalog.map((entry) => (
            <option key={entry.code} value={entry.code}>
              {entry.name}
            </option>
          ))}
        </select>
      </label>

      {chosen ? <p className="small muted">{chosen.description}</p> : null}

      <Field
        label="Name it"
        name="publicName"
        hint="How it appears on your page. For example: weekly bins."
        required
        maxLength={80}
        value={publicName}
        onChange={(e) => setPublicName(e.target.value)}
      />

      <label className="field">
        <span className="field__label">What exactly is included?</span>
        <span className="field__hint">
          Be specific about what you will and will not do. This cannot add anything outside the
          service you picked above.
        </span>
        <textarea
          className="field__input"
          name="description"
          rows={4}
          required
          maxLength={1200}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>

      <Field
        label="Price per week"
        name="price"
        type="number"
        step="0.50"
        min="0.50"
        hint={
          Number.isFinite(perCycleCents) && perCycleCents > 0
            ? `You keep all of this. The most one visit can be priced at is ${formatCents(MAX_OCCURRENCE_PRICE_CENTS)}. Billed every ${WEEKS_PER_CYCLE} weeks, so a customer is charged ${formatCents(perCycleCents)} at a time, plus a small platform fee.`
            : `You keep all of this. The most one visit can be priced at is ${formatCents(MAX_OCCURRENCE_PRICE_CENTS)}.`
        }
        required
        value={price}
        onChange={(e) => setPrice(e.target.value)}
      />

      <label className="field">
        <span className="field__label">Which day?</span>
        <select
          className="field__input"
          name="weekday"
          value={weekday}
          onChange={(e) => setWeekday(e.target.value)}
        >
          {WEEKDAYS.map((d) => (
            <option key={d} value={d}>
              {d.charAt(0).toUpperCase() + d.slice(1)}
            </option>
          ))}
        </select>
      </label>

      <Field
        label="How many houses at most?"
        name="capacity"
        type="number"
        min="1"
        max="500"
        hint="Start small. Raising it once the route is full is easier than letting people down."
        required
        value={capacity}
        onChange={(e) => setCapacity(e.target.value)}
      />

      <button className="btn btn--full" type="submit" disabled={busy}>
        {busy ? 'Saving...' : 'Add this service'}
      </button>
    </form>
  )
}

export function ServiceAreaForm({ serviceId }: { serviceId: string }) {
  const { error, busy, send } = useSubmit()
  const [line1, setLine1] = useState('')
  const [city, setCity] = useState('')
  const [region, setRegion] = useState('')
  const [postalCode, setPostalCode] = useState('')
  const [radius, setRadius] = useState(String(DEFAULT_RADIUS_METRES))

  return (
    <form
      className="stack"
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        void send(
          `/api/v1/provider-services/${serviceId}/service-area`,
          {
            centre: { line1, city, region, postalCode, countryCode: 'US' },
            radiusMetres: Math.round(Number(radius)),
          },
          'PUT',
        )
      }}
    >
      {error ? <Alert kind="error">{error}</Alert> : null}

      <Alert kind="info">
        Pick a middle point and how far around it you will go. A street corner, your school, a shop:
        it does not have to be your house, and it is never shown to anyone.
      </Alert>

      <Field
        label="Middle point"
        name="line1"
        hint="A street address near the middle of your round."
        required
        value={line1}
        onChange={(e) => setLine1(e.target.value)}
      />
      <Field
        label="Town or city"
        name="city"
        required
        value={city}
        onChange={(e) => setCity(e.target.value)}
      />
      <Field
        label="State"
        name="region"
        hint="Two letters, like TX."
        maxLength={2}
        required
        value={region}
        onChange={(e) => setRegion(e.target.value.toUpperCase())}
      />
      <Field
        label="ZIP"
        name="postalCode"
        required
        value={postalCode}
        onChange={(e) => setPostalCode(e.target.value)}
      />

      <label className="field">
        <span className="field__label">
          How far will you go? {describeRadius(Number(radius))}
        </span>
        <span className="field__hint">
          Keep it to what you would actually walk. A full small round earns more than a big empty
          one.
        </span>
        <input
          className="field__input"
          name="radiusMetres"
          type="range"
          min={100}
          max={3000}
          step={100}
          value={radius}
          onChange={(e) => setRadius(e.target.value)}
        />
      </label>

      <button className="btn btn--full" type="submit" disabled={busy}>
        {busy ? 'Saving...' : 'Save my area'}
      </button>
    </form>
  )
}

/**
 * Turn a service on or off.
 *
 * A service is a draft until the provider says it is ready. Activating is
 * refused server-side without a schedule and an area, so this button can
 * be offered before those exist and give a specific reason rather than
 * being hidden and leaving the provider wondering what is missing.
 */
export function ServiceStateToggle({
  serviceId,
  state,
}: {
  serviceId: string
  state: string
}) {
  const { error, busy, send } = useSubmit()
  const next = state === 'active' ? 'paused' : 'active'

  return (
    <div>
      {error ? <Alert kind="error">{error}</Alert> : null}
      <button
        className="btn btn--secondary"
        type="button"
        disabled={busy}
        onClick={() =>
          void send(`/api/v1/provider-services/${serviceId}/state`, { state: next }, 'PUT')
        }
      >
        {busy ? 'Saving...' : state === 'active' ? 'Pause this' : 'Turn this on'}
      </button>
    </div>
  )
}

export function PublishButton({ businessId }: { businessId: string }) {
  const { error, busy, send } = useSubmit()

  return (
    <div className="stack">
      {error ? <Alert kind="error">{error}</Alert> : null}
      <button
        className="btn btn--full"
        type="button"
        disabled={busy}
        onClick={() => void send(`/api/v1/businesses/${businessId}/publish`, {})}
      >
        {busy ? 'Publishing...' : 'Publish my page'}
      </button>
    </div>
  )
}
