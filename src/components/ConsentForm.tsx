'use client'

/**
 * An itemized consent, rendered from the canonical document.
 *
 * Renders from domain/consent.ts -- the same array that gets hashed into
 * the signed record. A copy pasted into JSX would let what somebody saw
 * drift from what was stored against their name, which is the one thing an
 * e-signature record has to rule out.
 *
 * Every box must be checked and a name typed before the button enables.
 * The server enforces both; this only stops a pointless round trip.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Alert, Field } from '@/components/ui'
import { CONSENT_DOCUMENTS, renderText, type ConsentKind } from '@/domain/consent'

export function ConsentForm({
  kind,
  minorName,
  submitLabel,
}: {
  kind: Extract<ConsentKind, 'guardian_consent' | 'public_listing_consent'>
  minorName: string
  submitLabel: string
}) {
  const router = useRouter()
  const doc = CONSENT_DOCUMENTS[kind]
  const values = { minor_name: minorName }

  const [acknowledged, setAcknowledged] = useState<string[]>([])
  const [typedName, setTypedName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const complete =
    doc.items.every((i) => acknowledged.includes(i.key)) && typedName.trim().length >= 3

  async function sign() {
    setError(null)
    setBusy(true)
    try {
      const res = await fetch('/api/v1/guardian/consents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, acknowledgedItems: acknowledged, typedName }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(body?.error?.message ?? 'We could not record that. Please try again.')
        return
      }
      router.refresh()
    } catch {
      setError('We could not reach the server. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="stack">
      {error ? <Alert kind="error">{error}</Alert> : null}

      <p className="muted">{renderText(doc.intro, values)}</p>

      <fieldset className="attest">
        <legend className="field__label">{doc.title}</legend>
        {doc.items.map((item) => (
          <label key={item.key} className="attest__item">
            <input
              type="checkbox"
              checked={acknowledged.includes(item.key)}
              onChange={(e) =>
                setAcknowledged((prev) =>
                  e.target.checked ? [...prev, item.key] : prev.filter((k) => k !== item.key),
                )
              }
            />
            <span>{renderText(item.text, values)}</span>
          </label>
        ))}
      </fieldset>

      <Field
        label="Type your full legal name to sign"
        name="typedName"
        hint={renderText(doc.statement, values)}
        autoComplete="name"
        value={typedName}
        onChange={(e) => setTypedName(e.target.value)}
      />

      <p className="small muted" style={{ marginBottom: 0 }}>
        {/* ESIGN/UETA. Say what is being kept, because it is being kept. */}
        Signing records your name, the date and time, and the exact version of this document.
        You can withdraw it at any time.
      </p>

      <button className="btn btn--full" type="button" onClick={sign} disabled={busy || !complete}>
        {busy ? 'Recording...' : submitLabel}
      </button>
    </div>
  )
}

export function MakeListingPrivate() {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  return (
    <>
      {error ? <Alert kind="error">{error}</Alert> : null}
      <button
        className="btn btn--secondary"
        type="button"
        disabled={busy}
        onClick={async () => {
          setError(null)
          setBusy(true)
          try {
            const res = await fetch('/api/v1/guardian/public-listing', { method: 'DELETE' })
            if (!res.ok) {
              const body = await res.json().catch(() => ({}))
              setError(body?.error?.message ?? 'That did not work.')
              return
            }
            router.refresh()
          } finally {
            setBusy(false)
          }
        }}
      >
        {busy ? 'Working...' : 'Remove from search'}
      </button>
    </>
  )
}
