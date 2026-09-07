'use client'

/**
 * Step one: a first name, and confirming you are an adult.
 *
 * ## No date of birth
 *
 * This asked for one, because a provider's age decided whether a guardian
 * was required and there were three bands to place them in. There is one
 * band now, so the question is a yes/no -- and asking for a birth date to
 * answer a yes/no would be the worst available option. FTC guidance says
 * an operator that asks for and receives a date of birth showing a user is
 * under 13 has actual knowledge of that for COPPA purposes; not asking
 * creates no such obligation.
 *
 * The attestation is a real record, not a checkbox that vanishes. It is
 * stored as a consent record with the exact wording that was on screen,
 * the same as the customer's -- see domain/consent.ts.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Alert, Field } from '@/components/ui'

export function ProviderDetailsForm() {
  const router = useRouter()
  const [firstName, setFirstName] = useState('')
  const [isAdult, setIsAdult] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (!isAdult) {
      setError('You have to be 18 or over to list a service here.')
      return
    }

    setBusy(true)
    try {
      const res = await fetch('/api/v1/provider/onboarding/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayFirstName: firstName, countryCode: 'US' }),
      })
      const body = await res.json().catch(() => ({}))

      if (!res.ok) {
        setError(body?.error?.message ?? 'We could not save that. Please try again.')
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
    <form onSubmit={submit} className="stack" noValidate>
      {error ? <Alert kind="error">{error}</Alert> : null}

      <Field
        label="First name"
        name="firstName"
        hint="Customers see this. Your last name is never shown."
        autoComplete="given-name"
        maxLength={60}
        required
        value={firstName}
        onChange={(e) => setFirstName(e.target.value)}
      />

      <label className="check">
        <input
          type="checkbox"
          name="isAdult"
          checked={isAdult}
          onChange={(e) => setIsAdult(e.target.checked)}
        />
        <span>I am 18 or older.</span>
      </label>

      <button className="btn btn--full" type="submit" disabled={busy}>
        {busy ? 'Saving…' : 'Continue'}
      </button>
    </form>
  )
}
