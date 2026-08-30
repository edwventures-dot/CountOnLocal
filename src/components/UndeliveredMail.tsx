'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Alert } from '@/components/ui'
import type { DeadNotice } from '@/server/undeliveredMail'

/**
 * Mail the outbox gave up on.
 *
 * The `dead` state has always meant "a human should look" and there was
 * nowhere to look. Every row found when this was built was a guardian
 * invitation, which is the case that matters most: a minor waiting on an
 * approval that was never delivered, with no signal anywhere that it
 * failed.
 *
 * Shows the domain rather than the address. Enough to tell a typo from an
 * outage, without turning the console into a directory of everyone's email.
 */
export function UndeliveredMail({ notices }: { notices: DeadNotice[] }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [queued, setQueued] = useState<number | null>(null)

  async function retry(ids: string[]) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/v1/admin/undelivered', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      })
      const parsed = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(parsed?.error?.message ?? 'That did not work.')
        return
      }
      setQueued(parsed.queued ?? 0)
      router.refresh()
    } catch {
      setError('We could not reach the server.')
    } finally {
      setBusy(false)
    }
  }

  if (notices.length === 0) {
    return (
      <p className="muted" style={{ marginBottom: 0 }}>
        Nothing undelivered. Every message the platform sent has either gone out or is still
        queued.
      </p>
    )
  }

  return (
    <>
      {error ? <Alert kind="error">{error}</Alert> : null}
      {queued !== null ? (
        <Alert kind="success">
          {queued} requeued. They go out on the next run, or die again if the address is genuinely
          wrong.
        </Alert>
      ) : null}

      <p className="small muted">
        {notices.length} message{notices.length === 1 ? '' : 's'} the outbox gave up on. A guardian
        invitation here means a minor is waiting on an approval that never arrived.
      </p>

      <ul className="list">
        {notices.map((n) => (
          <li key={n.id} className="list__item list__item--stacked">
            <div className="list__row">
              <span>
                <strong>{n.kind}</strong> · @{n.destinationDomain}
              </span>
              <span className="small muted">
                {n.attempts} attempt{n.attempts === 1 ? '' : 's'}
              </span>
            </div>
            {n.lastError ? <p className="small muted">{n.lastError.slice(0, 200)}</p> : null}
            <p className="small muted">
              {new Date(n.queuedAt).toLocaleString()}
              {n.recipientUserId ? ` · user ${n.recipientUserId}` : ' · no account'}
            </p>
            <button
              className="btn btn--link"
              type="button"
              disabled={busy}
              onClick={() => retry([n.id])}
            >
              Try again
            </button>
          </li>
        ))}
      </ul>

      <button
        className="btn btn--secondary"
        type="button"
        disabled={busy}
        onClick={() => retry(notices.map((n) => n.id))}
      >
        {busy ? 'Requeueing...' : `Try all ${notices.length} again`}
      </button>
    </>
  )
}
