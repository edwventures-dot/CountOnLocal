'use client'

/**
 * Step two: ask a parent or guardian to approve.
 *
 * Only reachable by a provider under 18. The invitation goes to an address
 * the young person types in, which is why nothing identifying travels in
 * the email -- see the preview text in guardianService.
 *
 * Resending is the same call. The server treats an invite to an already
 * invited relationship as a resend, issues a fresh token, and lets the old
 * one expire rather than accumulating live invitations.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Alert, Field } from '@/components/ui'

export function GuardianInviteForm({ alreadyInvited }: { alreadyInvited: boolean }) {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSent(false)
    setBusy(true)

    try {
      const res = await fetch('/api/v1/guardian/invitations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      })
      const body = await res.json().catch(() => ({}))

      if (!res.ok) {
        setError(body?.error?.message ?? 'We could not send that. Please try again.')
        return
      }

      setSent(true)
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
      {sent ? (
        <Alert kind="success">
          Sent. Ask them to check their email — including the junk folder, since it is the first
          message we have sent them.
        </Alert>
      ) : null}

      <Field
        label="Your parent or guardian's email"
        name="guardianEmail"
        type="email"
        hint="We will email them a link. It does not mention your name, your service or where you live — they see that after they sign in."
        autoComplete="off"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />

      <button className="btn btn--full" type="submit" disabled={busy}>
        {busy ? 'Sending…' : alreadyInvited ? 'Send it again' : 'Send the request'}
      </button>
    </form>
  )
}
