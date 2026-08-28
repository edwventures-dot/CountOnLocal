'use client'

/**
 * One stop, and the two things you can do with it.
 *
 * This is the screen a provider holds in one hand, outdoors, possibly in
 * the rain, at seven in the morning. UX_UI_SPEC section 5 asks for 44px
 * touch targets; here that is a floor rather than a target, and the
 * buttons are full width because a mis-tap on "skip" instead of "done"
 * costs somebody money.
 *
 * ## Done is not undoable from here
 *
 * Completing writes a timestamp and moves the occurrence toward
 * settlement. There is no undo button because there is no undo endpoint --
 * the state machine allows completed to settle, not to reverse. Saying so
 * plainly beats offering a control that would fail.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Alert } from '@/components/ui'

type Outcome = { kind: 'idle' } | { kind: 'busy' } | { kind: 'done'; state: string } | { kind: 'error'; message: string }

/**
 * The photo, taken before the stop is marked done.
 *
 * `capture="environment"` asks a phone for the rear camera directly, so
 * the common case is one tap rather than a trip through the gallery.
 *
 * Optional, deliberately. A required photo means a provider with a flat
 * battery or no signal cannot mark work they actually did, and the
 * consequence of that is a customer not being charged and a teenager not
 * being paid. Evidence is worth a lot; it is not worth blocking the round.
 */
function PhotoUpload({ occurrenceId }: { occurrenceId: string }) {
  const [state, setState] = useState<'idle' | 'sending' | 'done'>('idle')
  const [error, setError] = useState<string | null>(null)

  if (state === 'done') {
    return (
      <p className="small" style={{ color: 'var(--col-green)', margin: 0, fontWeight: 700 }}>
        Photo added
      </p>
    )
  }

  return (
    <div>
      {error ? <Alert kind="error">{error}</Alert> : null}
      <label className="field">
        <span className="field__label">Photo (optional)</span>
        <span className="field__hint">
          Proof the job was done, if there is a dispute later. Location data is removed before it is
          stored, and only you, the customer and their guardian can see it.
        </span>
        <input
          className="field__input"
          type="file"
          accept="image/jpeg,image/png"
          capture="environment"
          disabled={state === 'sending'}
          onChange={async (e) => {
            const file = e.target.files?.[0]
            if (!file) return
            setError(null)
            setState('sending')
            try {
              const res = await fetch(`/api/v1/occurrences/${occurrenceId}/photo`, {
                method: 'POST',
                headers: { 'Content-Type': file.type || 'application/octet-stream' },
                body: file,
              })
              if (!res.ok) {
                const body = await res.json().catch(() => ({}))
                setError(body?.error?.message ?? 'That photo would not upload.')
                setState('idle')
                return
              }
              setState('done')
            } catch {
              setError('No signal. You can still mark this done.')
              setState('idle')
            }
          }}
        />
      </label>
    </div>
  )
}

export function RouteStopActions({ occurrenceId }: { occurrenceId: string }) {
  const router = useRouter()
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' })
  const [skipping, setSkipping] = useState(false)
  const [reason, setReason] = useState('')

  async function act(path: string, body: Record<string, unknown>) {
    setOutcome({ kind: 'busy' })
    try {
      const res = await fetch(`/api/v1/occurrences/${occurrenceId}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ occurrenceId, ...body }),
      })
      const parsed = await res.json().catch(() => ({}))
      if (!res.ok) {
        setOutcome({
          kind: 'error',
          message: parsed?.error?.message ?? 'That did not save. Please try again.',
        })
        return
      }
      setOutcome({ kind: 'done', state: parsed?.state ?? 'completed' })
      router.refresh()
    } catch {
      setOutcome({ kind: 'error', message: 'No signal. Try again when you are back online.' })
    }
  }

  if (outcome.kind === 'done') {
    return (
      <p className="small" style={{ color: 'var(--col-green)', margin: 0, fontWeight: 700 }}>
        {outcome.state === 'completed' ? 'Marked done' : 'Skipped'}
      </p>
    )
  }

  const busy = outcome.kind === 'busy'

  return (
    <div className="stack">
      {outcome.kind === 'error' ? <Alert kind="error">{outcome.message}</Alert> : null}

      {skipping ? (
        <>
          <label className="field">
            <span className="field__label">Why are you skipping this one?</span>
            {/* The customer is credited for a provider skip regardless of
                notice, so this is a record rather than a gate. */}
            <span className="field__hint">
              They will not be charged for it. A short note helps if they ask.
            </span>
            <input
              className="field__input"
              name="reason"
              maxLength={200}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <button
            className="btn btn--full"
            type="button"
            disabled={busy}
            onClick={() => void act('provider-skip', reason.trim() ? { reason: reason.trim() } : {})}
          >
            {busy ? 'Saving...' : 'Confirm skip'}
          </button>
          <button className="btn btn--link" type="button" onClick={() => setSkipping(false)}>
            Back
          </button>
        </>
      ) : (
        <>
          <PhotoUpload occurrenceId={occurrenceId} />
          <button
            className="btn btn--full btn--tall"
            type="button"
            disabled={busy}
            onClick={() => void act('complete', {})}
          >
            {busy ? 'Saving...' : 'Done'}
          </button>
          <button className="btn btn--link" type="button" onClick={() => setSkipping(true)}>
            Could not do this one
          </button>
        </>
      )}
    </div>
  )
}
