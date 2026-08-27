'use client'

/**
 * Skip, pause, resume, cancel.
 *
 * PRD section 13 makes these self-service, and the reason is not
 * convenience: a customer who cannot stop a recurring charge without
 * emailing somebody will stop it at their bank instead, and a chargeback
 * lands on a teenager's payout.
 *
 * ## Every destructive action shows its consequence first
 *
 * Pause and cancel both have a preview endpoint that says how many visits
 * are released, how many of those earn credit, and what would be refunded.
 * Nothing here recomputes any of that -- the numbers on the confirmation
 * are the ones the server will act on, fetched from the same endpoint that
 * performs the action.
 *
 * A customer agreeing to "cancel" without seeing that three paid visits
 * are involved has not really agreed.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Alert } from '@/components/ui'

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`

type EndingPreview = {
  effectiveFrom: string
  visitsReleased: number
  visitsCredited: number
  creditCents?: number
  refundableCents?: number
}

function useAction() {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function call(url: string, method: string, body?: unknown) {
    setError(null)
    setBusy(true)
    try {
      const res = await fetch(url, {
        method,
        ...(body === undefined
          ? {}
          : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      })
      const parsed = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(parsed?.error?.message ?? 'That did not work. Please try again.')
        return null
      }
      return parsed as Record<string, unknown>
    } catch {
      setError('We could not reach the server. Please try again.')
      return null
    } finally {
      setBusy(false)
    }
  }

  return { error, busy, call, refresh: () => router.refresh() }
}

export function SkipVisit({
  subscriptionId,
  occurrenceId,
  serviceDate,
}: {
  subscriptionId: string
  occurrenceId: string
  serviceDate: string
}) {
  const { error, busy, call, refresh } = useAction()
  const [done, setDone] = useState(false)

  if (done) return <span className="small muted">Skipped</span>

  return (
    <>
      {error ? <Alert kind="error">{error}</Alert> : null}
      <button
        className="btn btn--link"
        type="button"
        disabled={busy}
        onClick={async () => {
          const r = await call(`/api/v1/subscriptions/${subscriptionId}/skip`, 'POST', {
            occurrenceId,
          })
          if (r) {
            setDone(true)
            refresh()
          }
        }}
      >
        {busy ? 'Skipping...' : `Skip ${serviceDate}`}
      </button>
    </>
  )
}

/**
 * Pause or cancel, behind a preview.
 *
 * The two share everything except wording and the verb, and keeping them
 * as one component is what stops the cancel path quietly losing the
 * preview step when somebody edits the pause path.
 */
export function EndSubscription({
  subscriptionId,
  kind,
}: {
  subscriptionId: string
  kind: 'pause' | 'cancel'
}) {
  const { error, busy, call, refresh } = useAction()
  const [preview, setPreview] = useState<EndingPreview | null>(null)

  const label = kind === 'pause' ? 'Pause' : 'Cancel'

  if (!preview) {
    return (
      <>
        {error ? <Alert kind="error">{error}</Alert> : null}
        <button
          className="btn btn--secondary"
          type="button"
          disabled={busy}
          onClick={async () => {
            const r = await call(`/api/v1/subscriptions/${subscriptionId}/${kind}`, 'GET')
            if (r) setPreview(r as unknown as EndingPreview)
          }}
        >
          {busy ? 'Checking...' : label}
        </button>
      </>
    )
  }

  return (
    <div className="stack">
      {error ? <Alert kind="error">{error}</Alert> : null}

      <Alert kind="info">
        <strong>
          {label} from {preview.effectiveFrom}?
        </strong>
        <br />
        {preview.visitsReleased === 0
          ? 'No visits are affected.'
          : `${preview.visitsReleased} visit${preview.visitsReleased === 1 ? '' : 's'} released, ${preview.visitsCredited} of them credited back to you.`}
        {kind === 'cancel' && typeof preview.refundableCents === 'number' && preview.refundableCents > 0 ? (
          <>
            <br />
            {money(preview.refundableCents)} will be refunded.
          </>
        ) : null}
        {kind === 'pause' ? (
          <>
            <br />
            {/* Says plainly that money is not coming back, because the
                alternative is a customer expecting a refund that the
                product deliberately does not give on a pause. */}
            Nothing is refunded on a pause. Any credit stays on your account and is used when you
            resume.
          </>
        ) : null}
      </Alert>

      <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
        <button
          className="btn"
          type="button"
          disabled={busy}
          onClick={async () => {
            const r = await call(`/api/v1/subscriptions/${subscriptionId}/${kind}`, 'POST')
            if (r) {
              setPreview(null)
              refresh()
            }
          }}
        >
          {busy ? 'Working...' : `Yes, ${label.toLowerCase()}`}
        </button>
        <button className="btn btn--secondary" type="button" onClick={() => setPreview(null)}>
          Keep it
        </button>
      </div>
    </div>
  )
}

export function ResumeSubscription({ subscriptionId }: { subscriptionId: string }) {
  const { error, busy, call, refresh } = useAction()

  return (
    <>
      {error ? <Alert kind="error">{error}</Alert> : null}
      <button
        className="btn"
        type="button"
        disabled={busy}
        onClick={async () => {
          const r = await call(`/api/v1/subscriptions/${subscriptionId}/pause`, 'DELETE')
          if (r) refresh()
        }}
      >
        {busy ? 'Resuming...' : 'Resume'}
      </button>
    </>
  )
}
