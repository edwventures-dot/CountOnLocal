'use client'

/**
 * The address check on a public storefront.
 *
 * PRD section 9 makes "Check my address" the primary call to action, and
 * section 10 puts eligibility before anything else in the customer flow.
 * This is the first thing a neighbour does after scanning a flyer, so it
 * answers in place rather than navigating away -- a page change here loses
 * people who are standing on their porch holding a phone.
 *
 * The component only ever learns a boolean about the address typed into it.
 * The service area is never sent to the browser.
 */

import { useState } from 'react'

type Outcome =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'eligible'; normalized: string }
  | { kind: 'ineligible'; normalized: string }
  | { kind: 'error'; message: string }

export function AddressCheck({ providerServiceId }: { providerServiceId: string }) {
  const [line1, setLine1] = useState('')
  const [city, setCity] = useState('')
  const [region, setRegion] = useState('')
  const [postalCode, setPostalCode] = useState('')
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' })

  async function check(e: React.FormEvent) {
    e.preventDefault()
    setOutcome({ kind: 'checking' })

    try {
      const res = await fetch(`/api/v1/public/provider-services/${providerServiceId}/eligibility`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ line1, city, region, postalCode, countryCode: 'US' }),
      })
      const body = await res.json()

      if (!res.ok) {
        setOutcome({
          kind: 'error',
          message: body?.error?.message ?? 'We could not check that address right now.',
        })
        return
      }

      setOutcome(
        body.eligible
          ? { kind: 'eligible', normalized: body.normalizedAddress }
          : { kind: 'ineligible', normalized: body.normalizedAddress },
      )
    } catch {
      setOutcome({ kind: 'error', message: 'We could not reach the server. Please try again.' })
    }
  }

  const busy = outcome.kind === 'checking'

  return (
    <div style={{ marginTop: 18 }}>
      <form onSubmit={check}>
        <div style={S.row}>
          <input
            required
            value={line1}
            onChange={(e) => setLine1(e.target.value)}
            placeholder="Street address"
            aria-label="Street address"
            style={{ ...S.input, flex: 1 }}
          />
        </div>
        <div style={S.row}>
          <input
            required
            value={city}
            onChange={(e) => setCity(e.target.value)}
            placeholder="City"
            aria-label="City"
            style={{ ...S.input, flex: 2 }}
          />
          <input
            required
            value={region}
            onChange={(e) => setRegion(e.target.value.toUpperCase().slice(0, 2))}
            placeholder="State"
            aria-label="State"
            maxLength={2}
            style={{ ...S.input, width: 84 }}
          />
          <input
            required
            value={postalCode}
            onChange={(e) => setPostalCode(e.target.value)}
            placeholder="ZIP"
            aria-label="ZIP code"
            inputMode="numeric"
            style={{ ...S.input, width: 120 }}
          />
        </div>
        <button type="submit" disabled={busy} style={{ ...S.cta, opacity: busy ? 0.6 : 1 }}>
          {busy ? 'Checking…' : 'Check my address'}
        </button>
      </form>

      {outcome.kind === 'eligible' ? (
        <div style={S.yes} role="status">
          <strong>Good news — this address is on the route.</strong>
          <span style={S.normalized}>{outcome.normalized}</span>
          <button type="button" style={S.subscribe}>
            Subscribe
          </button>
        </div>
      ) : null}

      {outcome.kind === 'ineligible' ? (
        <div style={S.no} role="status">
          {/*
            Says only that this address is not covered. Not how far outside,
            not where the boundary is -- that would leak the shape of a
            minor's service area one guess at a time.
          */}
          <strong>This address is outside the current service area.</strong>
          <span style={S.normalized}>{outcome.normalized}</span>
        </div>
      ) : null}

      {outcome.kind === 'error' ? (
        <div style={S.err} role="alert">
          {outcome.message}
        </div>
      ) : null}
    </div>
  )
}

const INK = '#14263A'
const LIME = '#C7F34A'
const BORDER = '#DDE3E6'
const MUTED = '#607080'
const GREEN = '#16875B'
const CORAL = '#FF765C'

const S: Record<string, React.CSSProperties> = {
  row: { display: 'flex', gap: 10, marginBottom: 10 },
  input: { border: `1px solid ${BORDER}`, borderRadius: 12, padding: 14, fontSize: 15, minWidth: 0 },
  cta: {
    border: 0,
    borderRadius: 12,
    padding: '14px 18px',
    fontWeight: 850,
    background: LIME,
    color: INK,
    cursor: 'pointer',
    fontSize: 15,
  },
  yes: {
    marginTop: 14,
    padding: 14,
    borderRadius: 12,
    background: '#e7f6ef',
    color: GREEN,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  no: {
    marginTop: 14,
    padding: 14,
    borderRadius: 12,
    background: '#fff4f1',
    color: '#9c3a26',
    borderLeft: `4px solid ${CORAL}`,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  err: {
    marginTop: 14,
    padding: 14,
    borderRadius: 12,
    background: '#fdf3f3',
    color: '#a33',
  },
  normalized: { fontSize: 13, color: MUTED },
  subscribe: {
    alignSelf: 'flex-start',
    marginTop: 6,
    border: 0,
    borderRadius: 10,
    padding: '10px 14px',
    fontWeight: 850,
    background: INK,
    color: LIME,
    cursor: 'pointer',
  },
}
