'use client'

/**
 * Waitlist capture for the coming-soon page.
 *
 * A client component because it needs state and a submit handler; everything
 * around it on the landing page stays a server component.
 */

import { useState } from 'react'
import { WAITLIST_ROLES, type WaitlistRole } from '@/domain/waitlist'
import { BORDER, CORAL, GREEN, INK, LIME, MUTED, RADIUS_CONTROL, WHITE } from '@/lib/brand'

const ROLE_LABEL: Record<WaitlistRole, string> = {
  provider: 'I want to start a business',
  customer: 'I want to hire local help',
  guardian: 'I am a parent or guardian',
}

type Status = 'idle' | 'sending' | 'done' | 'error'

export function WaitlistForm() {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<WaitlistRole>('provider')
  const [postalCode, setPostalCode] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [message, setMessage] = useState('')

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setStatus('sending')
    setFieldErrors({})
    setMessage('')

    try {
      const res = await fetch('/api/v1/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, role, postalCode }),
      })

      if (res.ok) {
        setStatus('done')
        return
      }

      const body = await res.json().catch(() => null)
      setFieldErrors(body?.error?.fieldErrors ?? {})
      setMessage(body?.error?.message ?? 'Something went wrong. Try again shortly.')
      setStatus('error')
    } catch {
      setMessage('Could not reach the server. Check your connection and try again.')
      setStatus('error')
    }
  }

  if (status === 'done') {
    return (
      <div style={S.done} role="status">
        <strong style={{ display: 'block', fontSize: 18, marginBottom: 6 }}>You are on the list.</strong>
        <span style={{ color: MUTED }}>
          We will email you when Count On Local opens in your area. No other mail, ever.
        </span>
      </div>
    )
  }

  return (
    <form onSubmit={onSubmit} style={S.form} noValidate>
      <fieldset style={S.fieldset}>
        <legend style={S.legend}>How would you use it?</legend>
        <div style={S.roles}>
          {WAITLIST_ROLES.map((r) => (
            <label key={r} style={{ ...S.role, ...(role === r ? S.roleOn : null) }}>
              <input
                type="radio"
                name="role"
                value={r}
                checked={role === r}
                onChange={() => setRole(r)}
                style={S.radio}
              />
              {ROLE_LABEL[r]}
            </label>
          ))}
        </div>
      </fieldset>

      <div style={S.row}>
        <div style={{ flex: '2 1 260px' }}>
          <label htmlFor="wl-email" style={S.label}>
            Email
          </label>
          <input
            id="wl-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
            aria-invalid={Boolean(fieldErrors.email)}
            aria-describedby={fieldErrors.email ? 'wl-email-err' : undefined}
            style={{ ...S.input, ...(fieldErrors.email ? S.inputBad : null) }}
          />
          {fieldErrors.email ? (
            <p id="wl-email-err" style={S.err}>
              {fieldErrors.email}
            </p>
          ) : null}
        </div>

        <div style={{ flex: '1 1 130px' }}>
          <label htmlFor="wl-zip" style={S.label}>
            ZIP <span style={{ color: MUTED, fontWeight: 500 }}>(optional)</span>
          </label>
          <input
            id="wl-zip"
            inputMode="numeric"
            value={postalCode}
            onChange={(e) => setPostalCode(e.target.value)}
            placeholder="84043"
            autoComplete="postal-code"
            aria-invalid={Boolean(fieldErrors.postalCode)}
            aria-describedby={fieldErrors.postalCode ? 'wl-zip-err' : 'wl-zip-help'}
            style={{ ...S.input, ...(fieldErrors.postalCode ? S.inputBad : null) }}
          />
          {fieldErrors.postalCode ? (
            <p id="wl-zip-err" style={S.err}>
              {fieldErrors.postalCode}
            </p>
          ) : null}
        </div>
      </div>

      <p id="wl-zip-help" style={S.help}>
        We open one neighborhood at a time. Your ZIP tells us where to go next -- it is the only
        location detail we ask for.
      </p>

      <button type="submit" disabled={status === 'sending'} style={S.submit}>
        {status === 'sending' ? 'Adding you...' : 'Join the waitlist'}
      </button>

      {status === 'error' && message ? (
        <p role="alert" style={{ ...S.err, marginTop: 10 }}>
          {message}
        </p>
      ) : null}

      <p style={S.fine}>
        Providers must be 13 or older, and 13 to 17 needs a parent or guardian connected before any
        paid work. We will not share your address with anyone.
      </p>
    </form>
  )
}

const S: Record<string, React.CSSProperties> = {
  form: { marginTop: 26, maxWidth: 560 },
  fieldset: { border: 0, padding: 0, margin: '0 0 16px' },
  legend: { padding: 0, fontWeight: 800, fontSize: 14, marginBottom: 10 },
  roles: { display: 'grid', gap: 8 },
  role: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    border: `1px solid ${BORDER}`,
    borderRadius: RADIUS_CONTROL,
    padding: '12px 14px',
    background: WHITE,
    fontWeight: 600,
    cursor: 'pointer',
  },
  roleOn: { border: `1px solid ${INK}`, boxShadow: `inset 0 0 0 1px ${INK}` },
  radio: { accentColor: INK, width: 17, height: 17, flex: 'none' },
  row: { display: 'flex', gap: 12, flexWrap: 'wrap' },
  label: { display: 'block', fontWeight: 800, fontSize: 14, marginBottom: 6 },
  input: {
    width: '100%',
    padding: '13px 14px',
    border: `1px solid ${BORDER}`,
    borderRadius: RADIUS_CONTROL,
    background: WHITE,
    color: INK,
    fontSize: 16,
  },
  inputBad: { border: `1px solid ${CORAL}`, boxShadow: `inset 0 0 0 1px ${CORAL}` },
  err: { color: CORAL, fontSize: 13, fontWeight: 700, margin: '6px 0 0' },
  help: { color: MUTED, fontSize: 13, margin: '10px 0 0', lineHeight: 1.5 },
  submit: {
    marginTop: 16,
    border: 0,
    borderRadius: RADIUS_CONTROL,
    padding: '15px 20px',
    fontWeight: 850,
    fontSize: 16,
    background: LIME,
    color: INK,
    cursor: 'pointer',
    width: '100%',
  },
  fine: { color: MUTED, fontSize: 12.5, lineHeight: 1.6, margin: '14px 0 0' },
  done: {
    marginTop: 26,
    maxWidth: 560,
    padding: '20px 22px',
    borderRadius: RADIUS_CONTROL,
    border: `1px solid ${GREEN}`,
    background: '#e7f6ef',
  },
}
