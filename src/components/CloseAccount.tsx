'use client'

import { useState } from 'react'
import { Alert } from '@/components/ui'

/**
 * Closing your own account.
 *
 * ## Why this exists as its own component
 *
 * The Privacy Notice says "You can close your account from your account
 * page." That sentence was published before this control existed, which is
 * the seventh time in this codebase a capability has been described and not
 * wired -- and the first time the description was on a legal page rather
 * than in a design document.
 *
 * ## The confirmation is the point
 *
 * Most "delete my account" dialogs say "this cannot be undone" and stop
 * there, which is both vague and, here, false in the other direction: a
 * great deal IS kept, for years, and the person is entitled to know that
 * before they click rather than after.
 *
 * So the flow is: ask the server what closure would actually do, show it
 * verbatim, then take a typed confirmation. The list comes from
 * GET /api/v1/account/close, which reads the same retention policy the
 * nightly job enforces -- so this screen cannot drift from the behaviour it
 * describes.
 *
 * ## Typing CLOSE rather than a checkbox
 *
 * A checkbox is one stray click. This is irreversible, cannot be undone by
 * support, and for a provider aged 13-17 it detaches an account a guardian
 * set up. A deliberate act deserves a deliberate gesture.
 */

type Effect = {
  summary: string
  erasedImmediately: Array<{ what: string; clock: string }>
  keptForNow: Array<{ what: string; forDays: number; because: string; clock: string }>
}

/** Turns a policy class name into something a person reads. */
const LABELS: Record<string, string> = {
  account_identity: 'Your name, email and phone number',
  message_ordinary: 'Messages you sent',
  message_flagged: 'Messages that were reported',
  completion_photo: 'Photos of finished visits',
  customer_address: 'Your addresses, including the map location',
  notification: 'Records of emails we sent you',
  ledger_entry: 'Payments, charges and payouts',
  audit_log: 'The record of actions taken on your account',
  consent_record: 'Guardian consent you signed',
  incident: 'Safety reports',
  account_action: 'Warnings, suspensions and bans',
}

const label = (what: string) => LABELS[what] ?? what.replace(/_/g, ' ')

const years = (days: number) =>
  days >= 365 ? `${Math.round(days / 365)} year${days >= 730 ? 's' : ''}` : `${days} days`

export function CloseAccount() {
  const [effect, setEffect] = useState<Effect | null>(null)
  const [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  async function loadEffect() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/v1/account/close')
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(body?.error?.message ?? 'We could not load this right now.')
        return
      }
      setEffect(body.effect as Effect)
    } catch {
      setError('We could not reach the server. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  async function close() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/v1/account/close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Closed by the account holder.' }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        // The two refusals -- money owed, live subscription -- come back
        // with a message that says what to do about it. Showing the
        // server's sentence rather than a generic failure is the whole
        // value of having written it there.
        setError(body?.error?.message ?? 'We could not close the account.')
        return
      }
      setDone(true)
    } catch {
      setError('We could not reach the server. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <Alert kind="success">
        <strong>Your account is closed.</strong> Your contact details and display name have been
        removed. You will be signed out shortly.
      </Alert>
    )
  }

  if (!effect) {
    return (
      <>
        {error ? <Alert kind="error">{error}</Alert> : null}
        <p className="muted">
          Closing your account removes your contact details and display name. Some records are kept
          for a set period — we will show you exactly which before you confirm.
        </p>
        <button className="btn btn--secondary" type="button" onClick={loadEffect} disabled={busy}>
          {busy ? 'Loading...' : 'Close my account'}
        </button>
      </>
    )
  }

  return (
    <>
      {error ? <Alert kind="error">{error}</Alert> : null}

      <p>{effect.summary}</p>

      <h3 className="small">Removed straight away</h3>
      <ul className="small">
        {effect.erasedImmediately.map((item) => (
          <li key={item.what}>{label(item.what)}</li>
        ))}
      </ul>

      <h3 className="small">Kept, and why</h3>
      <ul className="small">
        {effect.keptForNow.map((item) => (
          <li key={item.what}>
            <strong>{label(item.what)}</strong> — {years(item.forDays)} from {item.clock}.{' '}
            {item.because}
          </li>
        ))}
      </ul>

      <label className="field">
        <span className="field__label">
          Type <strong>CLOSE</strong> to confirm
        </span>
        <span className="field__hint">
          This cannot be undone, and support cannot reverse it.
        </span>
        <input
          className="field__input"
          value={confirmation}
          onChange={(e) => setConfirmation(e.target.value)}
          autoComplete="off"
        />
      </label>

      <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
        <button
          className="btn btn--danger"
          type="button"
          onClick={close}
          disabled={busy || confirmation.trim().toUpperCase() !== 'CLOSE'}
        >
          {busy ? 'Closing...' : 'Close my account permanently'}
        </button>
        <button
          className="btn btn--secondary"
          type="button"
          onClick={() => {
            setEffect(null)
            setConfirmation('')
            setError(null)
          }}
          disabled={busy}
        >
          Keep my account
        </button>
      </div>
    </>
  )
}
