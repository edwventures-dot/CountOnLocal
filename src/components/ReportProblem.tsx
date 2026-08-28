'use client'

/**
 * "Something went wrong."
 *
 * Filing is open to any signed-in user by design -- the person who most
 * needs to report something is the person it happened to, and putting a
 * support email in front of that means somebody reporting a threat has to
 * go looking for one first.
 *
 * ## Severity is not offered
 *
 * The category is chosen; the severity is derived from it server-side.
 * Somebody in distress should not have to work out which number gets them
 * seen quickly, and a severity field in the request would let anybody mark
 * their own complaint an emergency.
 *
 * ## The emergency line comes first
 *
 * SAFETY_TRUST_POLICY section 16. This is not an emergency service, and a
 * form that quietly accepts a report about someone in danger is worse than
 * one that says so before the first field.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Alert } from '@/components/ui'

/** Plain words. The stored category is the enum value. */
const CHOICES: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'service_quality', label: 'The work was not done, or not done properly' },
  { value: 'property_damage', label: 'Something was damaged' },
  { value: 'animal_safety', label: 'Something happened with an animal' },
  { value: 'payment_or_fraud', label: 'A payment or billing problem' },
  { value: 'unsafe_instruction', label: 'Someone was asked to do something unsafe' },
  { value: 'harassment_or_threat', label: 'Someone was threatened or harassed' },
  { value: 'physical_safety', label: 'Someone was hurt, or could be' },
  { value: 'other', label: 'Something else' },
]

export function ReportProblem({ subscriptionId }: { subscriptionId: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [category, setCategory] = useState('service_quality')
  const [narrative, setNarrative] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [filed, setFiled] = useState(false)

  if (filed) {
    return (
      <Alert kind="success">
        Reported. Someone will look at it — how quickly depends on what happened. We will be in
        touch.
      </Alert>
    )
  }

  if (!open) {
    return (
      <button className="btn btn--link" type="button" onClick={() => setOpen(true)}>
        Report a problem
      </button>
    )
  }

  return (
    <div className="stack">
      {error ? <Alert kind="error">{error}</Alert> : null}

      <Alert kind="info">
        If someone is in danger right now, call 911. Count On Local is not an emergency service and
        nobody is watching this form in real time.
      </Alert>

      <label className="field">
        <span className="field__label">What happened?</span>
        <select
          className="field__input"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          {CHOICES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span className="field__label">Tell us about it</span>
        <span className="field__hint">
          A sentence or two is enough. Include when it happened if you remember.
        </span>
        <textarea
          className="field__input"
          rows={4}
          maxLength={5000}
          value={narrative}
          onChange={(e) => setNarrative(e.target.value)}
        />
      </label>

      <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
        <button
          className="btn"
          type="button"
          disabled={busy || narrative.trim().length < 10}
          onClick={async () => {
            setError(null)
            setBusy(true)
            try {
              const res = await fetch('/api/v1/incidents', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ category, narrative, subscriptionId }),
              })
              const body = await res.json().catch(() => ({}))
              if (!res.ok) {
                setError(body?.error?.message ?? 'We could not file that. Please try again.')
                return
              }
              setFiled(true)
              router.refresh()
            } catch {
              setError('We could not reach the server. Please try again.')
            } finally {
              setBusy(false)
            }
          }}
        >
          {busy ? 'Sending...' : 'Send the report'}
        </button>
        <button className="btn btn--secondary" type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  )
}
