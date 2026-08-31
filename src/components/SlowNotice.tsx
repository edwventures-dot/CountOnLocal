'use client'

import { useEffect, useState } from 'react'

/**
 * Reassurance for a wait that has gone on longer than a moment.
 *
 * The address check calls a free US Census endpoint. It usually answers in
 * under a second, and on a bad day takes ten -- measured at 9.2s during
 * testing, which is why the geocoder's own timeout had to be raised.
 *
 * A disabled button reading "Checking..." is enough feedback for one second
 * and not for ten. The person cannot tell a slow lookup from a broken page,
 * and what they do about it is click again or give up. Neither is what we
 * want from somebody who is trying to buy something.
 *
 * Appears only after the wait becomes notable, so the ordinary fast case is
 * not cluttered with reassurance nobody needed.
 */
const SLOW_AFTER_MS = 2500

export function SlowNotice({
  waiting,
  children,
}: {
  waiting: boolean
  children: React.ReactNode
}) {
  const [slow, setSlow] = useState(false)

  useEffect(() => {
    if (!waiting) {
      setSlow(false)
      return
    }
    const id = setTimeout(() => setSlow(true), SLOW_AFTER_MS)
    return () => clearTimeout(id)
  }, [waiting])

  if (!waiting || !slow) return null

  return (
    // polite, not assertive: this is reassurance, and interrupting a screen
    // reader mid-sentence to deliver it would be worse than saying nothing.
    <p className="small muted" role="status" aria-live="polite" style={{ marginTop: '0.5rem' }}>
      {children}
    </p>
  )
}

/**
 * A spinner, for buttons that are doing something slow.
 *
 * Text alone was not enough: a disabled button reading "Paying..." with
 * nothing moving reads as a frozen page, and the thing people do about a
 * frozen page is press it again. Motion is what says "still working".
 *
 * aria-hidden because the surrounding text already says what is happening;
 * a screen reader announcing "image" here adds nothing.
 */
export function Spinner() {
  return <span className="spinner" aria-hidden="true" />
}
