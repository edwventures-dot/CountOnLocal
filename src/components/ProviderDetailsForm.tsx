'use client'

/**
 * Step one: a first name and a date of birth.
 *
 * ## Why a date of birth, and only here
 *
 * The signup form deliberately does not ask. Age matters for what you
 * DO, not for who you are: a provider's age decides whether a guardian is
 * required, and a customer only attests to being 18 at checkout. Asking
 * everyone at signup would collect a minor's exact date of birth from
 * someone who might only ever hire a neighbour.
 *
 * The form says what happens to it, because a fourteen-year-old typing
 * their birthday into a website deserves to be told.
 *
 * ## The server decides, not this form
 *
 * Nothing here computes an age or a guardian state. The value goes to the
 * server, which derives both -- row level security grants no client write
 * on provider_profiles precisely so the caller cannot choose their own
 * guardian_state. The check below is only to save a round trip on an
 * obviously impossible date.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Alert, Field } from '@/components/ui'

export function ProviderDetailsForm() {
  const router = useRouter()
  const [firstName, setFirstName] = useState('')
  const [dob, setDob] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
      setError('Enter your date of birth as year, month and day.')
      return
    }

    setBusy(true)
    try {
      const res = await fetch('/api/v1/provider/onboarding/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayFirstName: firstName, dateOfBirth: dob, countryCode: 'US' }),
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

      <Field
        label="Date of birth"
        name="dateOfBirth"
        type="date"
        hint="Private. It is never shown to customers and never leaves our servers. We use it to know whether you need a parent or guardian to approve your account."
        required
        value={dob}
        onChange={(e) => setDob(e.target.value)}
      />

      <button className="btn btn--full" type="submit" disabled={busy}>
        {busy ? 'Saving…' : 'Continue'}
      </button>
    </form>
  )
}
