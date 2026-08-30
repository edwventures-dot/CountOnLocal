'use client'

/**
 * Writing, answering and reporting reviews.
 *
 * ## What was missing
 *
 * The guardian consent says "customers can leave public reviews... reviews
 * build a public reputation". The service, the rules and the routes were
 * all built and tested; the storefront showed an aggregate star rating and
 * there was no way for anybody to actually write one, answer one, or report
 * one. So the rating shown was always the rating of zero reviews.
 *
 * That is the same declared-but-unwired pattern as the messaging system,
 * found in the same audit, and described in the same signed document.
 *
 * ## Why the rating is a set of buttons and not a select
 *
 * A rating is one tap on a phone in a driveway. A native select is two taps
 * and a scroll wheel, and on the provider side of this product the person
 * reading the result may be fourteen.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Alert } from '@/components/ui'
import {
  MAX_BODY_LENGTH,
  MAX_RATING,
  MAX_RESPONSE_LENGTH,
  MIN_RATING,
  REPORT_REASONS,
  type ReportReason,
} from '@/domain/review'

/** Plain words for the report reasons, which are stored as codes. */
const REASON_LABELS: Record<ReportReason, string> = {
  not_about_this_service: 'Not about this service',
  personal_information: 'Contains someone’s personal information',
  harassment: 'Harassment',
  sexual_content: 'Sexual content',
  threat: 'A threat',
  spam_or_advertising: 'Spam or advertising',
  off_platform_contact: 'Asking to arrange or pay outside Count On Local',
  other: 'Something else',
}

function useReviewAction() {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function call(url: string, body: unknown): Promise<boolean> {
    setError(null)
    setBusy(true)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const parsed = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(parsed?.error?.message ?? 'That did not work.')
        return false
      }
      router.refresh()
      return true
    } catch {
      setError('We could not reach the server.')
      return false
    } finally {
      setBusy(false)
    }
  }

  return { error, busy, call }
}

function Stars({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="stars" role="radiogroup" aria-label="Rating">
      {Array.from({ length: MAX_RATING - MIN_RATING + 1 }, (_, i) => i + MIN_RATING).map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={`${n} out of ${MAX_RATING}`}
          className={n <= value ? 'stars__star stars__star--on' : 'stars__star'}
          onClick={() => onChange(n)}
        >
          ★
        </button>
      ))}
    </div>
  )
}

export function LeaveReview({ occurrenceId }: { occurrenceId: string }) {
  const { error, busy, call } = useReviewAction()
  const [open, setOpen] = useState(false)
  const [rating, setRating] = useState(0)
  const [body, setBody] = useState('')
  const [done, setDone] = useState(false)

  if (done) {
    return <p className="small muted">Thanks — your review is published.</p>
  }

  if (!open) {
    return (
      <button className="btn btn--link" type="button" onClick={() => setOpen(true)}>
        Leave a review
      </button>
    )
  }

  return (
    <div className="review-form">
      {error ? <Alert kind="error">{error}</Alert> : null}

      <Stars value={rating} onChange={setRating} />

      <label className="field">
        <span className="field__label">Anything to add? (optional)</span>
        <span className="field__hint">
          This is public. Keep it about the work — never a street address, a phone number, or
          anybody&rsquo;s last name.
        </span>
        <textarea
          className="field__input"
          rows={3}
          maxLength={MAX_BODY_LENGTH}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </label>

      <button
        className="btn"
        type="button"
        disabled={busy || rating < MIN_RATING}
        onClick={async () => {
          const ok = await call('/api/v1/reviews', {
            occurrenceId,
            rating,
            // Empty stays empty rather than becoming an empty string the
            // server has to decide about.
            body: body.trim() || undefined,
          })
          if (ok) setDone(true)
        }}
      >
        {busy ? 'Publishing…' : 'Publish review'}
      </button>{' '}
      <button className="btn btn--link" type="button" onClick={() => setOpen(false)}>
        Not now
      </button>
    </div>
  )
}

export function RespondToReview({ reviewId }: { reviewId: string }) {
  const { error, busy, call } = useReviewAction()
  const [open, setOpen] = useState(false)
  const [body, setBody] = useState('')
  const [done, setDone] = useState(false)

  if (done) return <p className="small muted">Your reply is published.</p>

  if (!open) {
    return (
      <button className="btn btn--link" type="button" onClick={() => setOpen(true)}>
        Reply
      </button>
    )
  }

  return (
    <div className="review-form">
      {error ? <Alert kind="error">{error}</Alert> : null}
      <label className="field">
        <span className="field__label">Your reply</span>
        <span className="field__hint">
          Public, and it sits under the review permanently. One reply per review — write it as if
          the next customer will read it, because they will.
        </span>
        <textarea
          className="field__input"
          rows={3}
          maxLength={MAX_RESPONSE_LENGTH}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </label>
      <button
        className="btn"
        type="button"
        disabled={busy || body.trim().length === 0}
        onClick={async () => {
          const ok = await call(`/api/v1/reviews/${reviewId}/response`, { body: body.trim() })
          if (ok) setDone(true)
        }}
      >
        {busy ? 'Publishing…' : 'Publish reply'}
      </button>{' '}
      <button className="btn btn--link" type="button" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </div>
  )
}

export function ReportReview({ reviewId }: { reviewId: string }) {
  const { error, busy, call } = useReviewAction()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState<ReportReason | ''>('')
  const [detail, setDetail] = useState('')
  const [done, setDone] = useState(false)

  if (done) {
    return (
      <p className="small muted">
        Reported. A person will read this. Some reports take a review out of view straight away.
      </p>
    )
  }

  if (!open) {
    return (
      <button className="btn btn--link" type="button" onClick={() => setOpen(true)}>
        Report
      </button>
    )
  }

  return (
    <div className="review-form">
      {error ? <Alert kind="error">{error}</Alert> : null}

      <label className="field">
        <span className="field__label">What is wrong with it?</span>
        <select
          className="field__input"
          value={reason}
          onChange={(e) => setReason(e.target.value as ReportReason)}
        >
          <option value="">Choose a reason</option>
          {REPORT_REASONS.map((r) => (
            <option key={r} value={r}>
              {REASON_LABELS[r]}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span className="field__label">Anything else? (optional)</span>
        <textarea
          className="field__input"
          rows={2}
          maxLength={1000}
          value={detail}
          onChange={(e) => setDetail(e.target.value)}
        />
      </label>

      <button
        className="btn btn--secondary"
        type="button"
        disabled={busy || reason === ''}
        onClick={async () => {
          const ok = await call(`/api/v1/reviews/${reviewId}/report`, {
            reason,
            detail: detail.trim() || undefined,
          })
          if (ok) setDone(true)
        }}
      >
        {busy ? 'Sending…' : 'Send report'}
      </button>{' '}
      <button className="btn btn--link" type="button" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </div>
  )
}
