'use client'

/**
 * Staff actions, each of which writes an audit row.
 *
 * ## The reason field is not a formality
 *
 * checkReason refuses anything under 20 characters, and this form does not
 * try to soften that. The person who reads it later is deciding whether
 * somebody was treated fairly, and "fraud?" tells them nothing. The button
 * stays disabled until there is something worth logging, so the refusal
 * happens before the action rather than after it.
 *
 * The server checks the same rule. This is a courtesy, not the control.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Alert } from '@/components/ui'
import { MIN_REASON_LENGTH } from '@/domain/incident'

function useStaffAction() {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  /** Returns the parsed body on success, null on failure. Callers that only
   *  need "did it work" still read it as truthy. */
  async function call(url: string, method: string, body: unknown): Promise<Record<string, unknown> | null> {
    setError(null)
    setBusy(true)
    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.status === 404) {
        setError('This account cannot do that.')
        return null
      }
      const parsed = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(parsed?.error?.message ?? 'That did not work.')
        return null
      }
      router.refresh()
      return parsed as Record<string, unknown>
    } catch {
      setError('We could not reach the server.')
      return null
    } finally {
      setBusy(false)
    }
  }

  return { error, busy, call }
}

/** A reason field that will not let you skip it. */
function ReasonField({
  value,
  onChange,
  label,
}: {
  value: string
  onChange: (v: string) => void
  label: string
}) {
  const short = value.trim().length < MIN_REASON_LENGTH

  return (
    <label className="field">
      <span className="field__label">{label}</span>
      <span className="field__hint">
        At least {MIN_REASON_LENGTH} characters. Somebody will read this months from now with none
        of the context you have today.
      </span>
      <textarea
        className="field__input"
        rows={3}
        maxLength={2000}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {short && value.length > 0 ? (
        <span className="field__error">
          {MIN_REASON_LENGTH - value.trim().length} more characters
        </span>
      ) : null}
    </label>
  )
}

export function ResolveIncident({ incidentId }: { incidentId: string }) {
  const { error, busy, call } = useStaffAction()
  const [open, setOpen] = useState(false)
  const [resolution, setResolution] = useState('')

  if (!open) {
    return (
      <>
        {error ? <Alert kind="error">{error}</Alert> : null}
        <button className="btn btn--secondary" type="button" onClick={() => setOpen(true)}>
          Resolve
        </button>
      </>
    )
  }

  return (
    <div className="stack">
      {error ? <Alert kind="error">{error}</Alert> : null}
      <ReasonField
        label="What happened, and what did you do?"
        value={resolution}
        onChange={setResolution}
      />
      <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
        <button
          className="btn"
          type="button"
          disabled={busy || resolution.trim().length < MIN_REASON_LENGTH}
          onClick={async () => {
            if (await call(`/api/v1/admin/incidents/${incidentId}/resolve`, 'POST', { resolution })) {
              setOpen(false)
            }
          }}
        >
          {busy ? 'Saving...' : 'Resolve it'}
        </button>
        <button className="btn btn--secondary" type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  )
}

/**
 * Account consequences.
 *
 * Money is never a consequence here -- there is no field for a penalty and
 * there should not be one. Removing somebody costs them the work, which is
 * proportionate and does not require pricing somebody's bad week.
 */
export function AccountAction() {
  const { error, busy, call } = useStaffAction()
  const [subjectUserId, setSubjectUserId] = useState('')
  const [kind, setKind] = useState('strike')
  const [reason, setReason] = useState('')
  const [done, setDone] = useState<string | null>(null)

  return (
    <div className="stack">
      {error ? <Alert kind="error">{error}</Alert> : null}
      {done ? <Alert kind="success">{done}</Alert> : null}

      <label className="field">
        <span className="field__label">User id</span>
        <span className="field__hint">From an incident. There is no search by name.</span>
        <input
          className="field__input"
          value={subjectUserId}
          onChange={(e) => setSubjectUserId(e.target.value)}
        />
      </label>

      <label className="field">
        <span className="field__label">What are you doing?</span>
        <select className="field__input" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="strike">Strike — noted, no immediate effect</option>
          <option value="suspend">Suspend — cannot act until reinstated</option>
          <option value="ban">Ban — permanent, cannot be undone here</option>
          <option value="reinstate">Reinstate — clears a suspension and strikes</option>
        </select>
      </label>

      <ReasonField label="Why?" value={reason} onChange={setReason} />

      <button
        className="btn"
        type="button"
        disabled={busy || !subjectUserId.trim() || reason.trim().length < MIN_REASON_LENGTH}
        onClick={async () => {
          setDone(null)
          const r = await call('/api/v1/admin/account-actions', 'POST', {
            subjectUserId: subjectUserId.trim(),
            kind,
            reason,
          })
          if (r) {
            const standing = r['standing'] as { status?: string; strikes?: number } | undefined
            setDone(`Recorded. Account is now ${standing?.status} with ${standing?.strikes} strike(s).`)
          }
        }}
      >
        {busy ? 'Saving...' : 'Apply'}
      </button>
    </div>
  )
}
