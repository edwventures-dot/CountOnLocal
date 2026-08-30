'use client'

/**
 * The conversation attached to one subscription.
 *
 * ## Why this was worth building before anything else outstanding
 *
 * The guardian consent — itemised, typed-signature, stored in an
 * append-only table — says this:
 *
 *   "There is an in-app messaging system. [Your teen] can exchange messages
 *    with adult customers inside Count On Local, tied to a job. It has
 *    blocking and reporting and stricter controls for minors."
 *
 * Every part of that was true of the server and none of it was reachable.
 * A parent signed their legal name to a description of something no user
 * could open. That is the eighth time a capability has been described and
 * not wired, and the most serious: the other seven were design documents,
 * this one is a signed record.
 *
 * ## Deliberately plain
 *
 * No typing indicators, no read receipts beyond what the API already
 * returns, no attachments. Messaging here exists so a customer can say
 * "the side gate is stuck" — it is not a chat product, and every feature
 * added to it is another surface between an adult and a minor.
 *
 * ## Reporting sits next to every message, not in a menu
 *
 * SAFETY_TRUST_POLICY 9: block and report are always available. A report
 * control hidden behind an overflow menu is available in the sense that a
 * fire exit behind a locked door is available.
 */

import { useCallback, useEffect, useState } from 'react'
import { Alert } from '@/components/ui'

type Message = {
  id: string
  senderUserId: string
  body: string
  sentAt: string
  readAt: string | null
  mine: boolean
}

const MAX_BODY = 2000

export function MessageThread({
  subscriptionId,
  counterpartyLabel,
}: {
  subscriptionId: string
  /** "your provider" or the customer's street, depending who is reading. */
  counterpartyLabel: string
}) {
  const [messages, setMessages] = useState<Message[] | null>(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [reportingId, setReportingId] = useState<string | null>(null)
  const [reportReason, setReportReason] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/subscriptions/${subscriptionId}/messages`)
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(body?.error?.message ?? 'We could not load this conversation.')
        return
      }
      setMessages((body.messages ?? []) as Message[])
    } catch {
      setError('We could not reach the server.')
    }
  }, [subscriptionId])

  useEffect(() => {
    void load()
  }, [load])

  async function send() {
    const body = draft.trim()
    if (!body) return

    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const res = await fetch(`/api/v1/subscriptions/${subscriptionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      })
      const parsed = await res.json().catch(() => ({}))
      if (!res.ok) {
        // A blocked message comes back with the reason it was refused and
        // deliberately not the pattern that matched, which would be a hint
        // about how to rephrase it and get through.
        setError(parsed?.error?.message ?? 'That did not send.')
        return
      }
      setDraft('')
      await load()
    } catch {
      setError('We could not reach the server.')
    } finally {
      setBusy(false)
    }
  }

  async function report(messageId: string) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/v1/messages/${messageId}/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reportReason.trim() }),
      })
      const parsed = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(parsed?.error?.message ?? 'We could not file that report.')
        return
      }
      setReportingId(null)
      setReportReason('')
      // Says what happens next, because "reported" on its own leaves
      // somebody wondering whether anybody will actually look.
      setNotice('Reported. A person will read this, and the message is kept as evidence.')
      await load()
    } catch {
      setError('We could not reach the server.')
    } finally {
      setBusy(false)
    }
  }

  if (messages === null) {
    return <p className="muted small">Loading the conversation…</p>
  }

  return (
    <>
      {error ? <Alert kind="error">{error}</Alert> : null}
      {notice ? <Alert kind="success">{notice}</Alert> : null}

      {messages.length === 0 ? (
        <p className="muted small">
          Nothing here yet. Messages are tied to this service and are about the work — a gate code,
          a day that will not suit, a bin that was missed.
        </p>
      ) : (
        <ul className="thread">
          {messages.map((m) => (
            <li key={m.id} className={m.mine ? 'thread__msg thread__msg--mine' : 'thread__msg'}>
              <p className="thread__body">{m.body}</p>
              <p className="thread__meta">
                {m.mine ? 'You' : counterpartyLabel} ·{' '}
                {new Date(m.sentAt).toLocaleString(undefined, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
                {/* Reporting your own message is not a thing; everything
                    else can be reported by either party, always. */}
                {m.mine ? null : (
                  <>
                    {' · '}
                    <button
                      className="btn btn--link"
                      type="button"
                      onClick={() => {
                        setReportingId(m.id === reportingId ? null : m.id)
                        setReportReason('')
                      }}
                    >
                      Report
                    </button>
                  </>
                )}
              </p>

              {reportingId === m.id ? (
                <div className="thread__report">
                  <label className="field">
                    <span className="field__label">What is wrong with this message?</span>
                    <textarea
                      className="field__input"
                      rows={2}
                      maxLength={1000}
                      value={reportReason}
                      onChange={(e) => setReportReason(e.target.value)}
                    />
                  </label>
                  <button
                    className="btn btn--secondary"
                    type="button"
                    disabled={busy || reportReason.trim().length === 0}
                    onClick={() => report(m.id)}
                  >
                    {busy ? 'Sending…' : 'Send report'}
                  </button>{' '}
                  <button
                    className="btn btn--link"
                    type="button"
                    onClick={() => setReportingId(null)}
                  >
                    Cancel
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <label className="field">
        <span className="field__label">Send a message</span>
        <span className="field__hint">
          About this service only. Never share an address, a phone number or a way to pay outside
          Count On Local.
        </span>
        <textarea
          className="field__input"
          rows={3}
          maxLength={MAX_BODY}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="The side gate sticks — give it a shove."
        />
      </label>

      <button className="btn" type="button" onClick={send} disabled={busy || !draft.trim()}>
        {busy ? 'Sending…' : 'Send'}
      </button>
    </>
  )
}
