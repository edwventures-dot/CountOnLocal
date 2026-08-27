'use client'

/**
 * Step three: connect a payout account with Stripe.
 *
 * The link is created server-side and the return and refresh URLs are
 * built from configuration rather than accepted from the browser, so this
 * button cannot be turned into an open redirect.
 *
 * Who fills the form in depends on age: for a provider aged 13-17 it is the
 * guardian who legally holds the account. The copy says so rather than
 * sending a fourteen-year-old to a form asking for a tax identifier.
 */

import { useState } from 'react'
import { Alert } from '@/components/ui'

export function PayoutStart({ holder }: { holder: 'self' | 'guardian' }) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function start() {
    setError(null)
    setBusy(true)
    try {
      const res = await fetch('/api/v1/provider/payouts/onboarding-link', { method: 'POST' })
      const body = await res.json().catch(() => ({}))

      if (!res.ok || !body?.url) {
        setError(body?.error?.message ?? 'We could not start that right now. Please try again.')
        return
      }

      window.location.href = body.url
    } catch {
      setError('We could not reach the server. Please try again.')
      setBusy(false)
    }
  }

  return (
    <div className="stack">
      {error ? <Alert kind="error">{error}</Alert> : null}

      <p className="muted" style={{ marginBottom: 0 }}>
        {holder === 'guardian'
          ? 'Your guardian sets this up, because the account is legally theirs until you turn 18. Money you earn still goes to them on your behalf.'
          : 'Stripe handles this and asks for the details a bank needs. We never see or store your bank account number.'}
      </p>

      <button className="btn btn--full" type="button" onClick={start} disabled={busy}>
        {busy ? 'Opening Stripe…' : 'Set up payouts'}
      </button>
    </div>
  )
}
