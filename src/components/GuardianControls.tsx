'use client'

/**
 * The two things a guardian can do: stop the work, or end the arrangement.
 *
 * Both are deliberately reachable in one tap from the top of the
 * dashboard. SAFETY_TRUST_POLICY section 2 treats revocation as an
 * immediate control -- an adult who has decided something is wrong should
 * not have to hunt for the button, and the confirmation exists to prevent
 * a mis-tap rather than to talk them out of it.
 *
 * ## Pausing and revoking are not the same decision
 *
 * Pausing stops new customers and stops the page being public. Revoking
 * ends the guardian relationship itself, which stops future charges and
 * hands already-paid pending work to support for resolution. The copy says
 * which is which, because "pause" and "revoke" sound interchangeable and
 * are not.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Alert } from '@/components/ui'

function useGuardianAction() {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function call(url: string, body?: unknown) {
    setError(null)
    setBusy(true)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      const parsed = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(parsed?.error?.message ?? 'That did not work. Please try again.')
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

  return { error, busy, call }
}

export function PauseBusiness({
  businessId,
  providerName,
}: {
  businessId: string
  providerName: string
}) {
  const { error, busy, call } = useGuardianAction()
  const [confirming, setConfirming] = useState(false)

  if (!confirming) {
    return (
      <>
        {error ? <Alert kind="error">{error}</Alert> : null}
        <button className="btn btn--secondary" type="button" onClick={() => setConfirming(true)}>
          Pause the page
        </button>
      </>
    )
  }

  return (
    <div className="stack">
      {error ? <Alert kind="error">{error}</Alert> : null}
      <Alert kind="info">
        <strong>Pause {providerName}&rsquo;s page?</strong>
        <br />
        The page stops being public and nobody new can subscribe. Existing customers and visits
        already paid for are not affected, and you can undo this.
      </Alert>
      <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
        <button
          className="btn"
          type="button"
          disabled={busy}
          onClick={async () => {
            if (await call(`/api/v1/guardian/businesses/${businessId}/pause`, {
              reasonCode: 'guardian_request',
            })) {
              setConfirming(false)
            }
          }}
        >
          {busy ? 'Pausing...' : 'Yes, pause it'}
        </button>
        <button className="btn btn--secondary" type="button" onClick={() => setConfirming(false)}>
          Not now
        </button>
      </div>
    </div>
  )
}

export function RevokeApproval({
  relationshipId,
  providerName,
}: {
  relationshipId: string
  providerName: string
}) {
  const { error, busy, call } = useGuardianAction()
  const [confirming, setConfirming] = useState(false)

  if (!confirming) {
    return (
      <>
        {error ? <Alert kind="error">{error}</Alert> : null}
        <button className="btn btn--secondary" type="button" onClick={() => setConfirming(true)}>
          Withdraw my approval
        </button>
      </>
    )
  }

  return (
    <div className="stack">
      {error ? <Alert kind="error">{error}</Alert> : null}
      <Alert kind="error">
        <strong>Withdraw approval for {providerName}?</strong>
        <br />
        New customers and future charges stop straight away. Work that has already been paid for
        goes to our support team to sort out with you, rather than being dropped.
        <br />
        <br />
        {/* Honest about reversibility. The state machine allows a new
            invitation after a revocation, but it is a new relationship,
            not an undo. */}
        This is not a pause. Starting again means a fresh invitation.
      </Alert>
      <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
        <button
          className="btn"
          type="button"
          disabled={busy}
          onClick={async () => {
            if (await call(`/api/v1/guardian/relationships/${relationshipId}/revoke`, {
              reasonCode: 'guardian_request',
            })) {
              setConfirming(false)
            }
          }}
        >
          {busy ? 'Withdrawing...' : 'Yes, withdraw it'}
        </button>
        <button className="btn btn--secondary" type="button" onClick={() => setConfirming(false)}>
          Keep it
        </button>
      </div>
    </div>
  )
}
