'use client'

/**
 * Where the platform operates, as a staff control.
 *
 * The table and the rules module were built when the owner's response said
 * the platform is multi-state; this is the handle. Without it counsel's
 * answer could only be applied by writing SQL against production by hand,
 * which leaves no audit row and is the kind of gap that quietly stays open.
 *
 * ## The posture control is deliberately unfriendly
 *
 * Switching to `allowlist` closes every state nobody has explicitly
 * cleared. That is the single most consequential switch in the product —
 * one click could stop every customer in the country from subscribing — so
 * it sits behind its own reason field and its own confirmation, and it says
 * out loud what it is about to do.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Alert } from '@/components/ui'
import { MIN_REASON_LENGTH } from '@/domain/incident'
import { US_REGIONS, type LiveRule } from '@/server/jurisdictionAdmin'

function useJurisdiction() {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function call(method: 'POST' | 'PATCH', body: unknown): Promise<boolean> {
    setError(null)
    setBusy(true)
    try {
      const res = await fetch('/api/v1/admin/jurisdiction', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.status === 404) {
        setError('This account cannot change availability.')
        return false
      }
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

function Reason({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const short = value.trim().length < MIN_REASON_LENGTH
  return (
    <label className="field">
      <span className="field__label">Why</span>
      <span className="field__hint">
        At least {MIN_REASON_LENGTH} characters. A restriction nobody explained cannot be reviewed
        or lifted with confidence two years from now.
      </span>
      <textarea
        className="field__input"
        rows={2}
        maxLength={2000}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {short && value.length > 0 ? (
        <span className="field__error">{MIN_REASON_LENGTH - value.trim().length} more characters</span>
      ) : null}
    </label>
  )
}

export function AddJurisdictionRule({ catalog }: { catalog: ReadonlyArray<{ code: string; name: string }> }) {
  const { error, busy, call } = useJurisdiction()
  const [region, setRegion] = useState('')
  const [status, setStatus] = useState<'blocked' | 'allowed'>('blocked')
  const [catalogCode, setCatalogCode] = useState('')
  const [reason, setReason] = useState('')

  const ready = region !== '' && reason.trim().length >= MIN_REASON_LENGTH

  return (
    <>
      {error ? <Alert kind="error">{error}</Alert> : null}

      <label className="field">
        <span className="field__label">State</span>
        <select
          className="field__input"
          value={region}
          onChange={(e) => setRegion(e.target.value)}
        >
          <option value="">Choose a state</option>
          {US_REGIONS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span className="field__label">Rule</span>
        <select
          className="field__input"
          value={status}
          onChange={(e) => setStatus(e.target.value as 'blocked' | 'allowed')}
        >
          <option value="blocked">Not available — refuse new subscriptions here</option>
          <option value="allowed">Cleared — only matters under the allowlist posture</option>
        </select>
      </label>

      <label className="field">
        <span className="field__label">Which service</span>
        <span className="field__hint">
          Leave as the whole state unless only one kind of work is affected. A state that restricts
          dog walking by minors has not restricted lawn mowing.
        </span>
        <select
          className="field__input"
          value={catalogCode}
          onChange={(e) => setCatalogCode(e.target.value)}
        >
          <option value="">The whole state</option>
          {catalog.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name}
            </option>
          ))}
        </select>
      </label>

      <Reason value={reason} onChange={setReason} />

      <button
        className="btn"
        type="button"
        disabled={busy || !ready}
        onClick={async () => {
          const ok = await call('POST', { region, status, catalogCode, reason })
          if (ok) {
            setRegion('')
            setCatalogCode('')
            setReason('')
          }
        }}
      >
        {busy ? 'Saving...' : 'Add rule'}
      </button>
    </>
  )
}

export function LiveRules({ rules }: { rules: LiveRule[] }) {
  const { error, busy, call } = useJurisdiction()
  const [liftingId, setLiftingId] = useState<string | null>(null)
  const [reason, setReason] = useState('')

  if (rules.length === 0) {
    return (
      <p className="muted">
        Nothing is restricted. Count On Local is available in every state, which is the position the
        product owner set on 30 August 2026 pending counsel&rsquo;s review.
      </p>
    )
  }

  return (
    <>
      {error ? <Alert kind="error">{error}</Alert> : null}
      <ul className="small">
        {rules.map((rule) => (
          <li key={rule.id} style={{ marginBottom: 'var(--space-3)' }}>
            <strong>
              {rule.region}
              {rule.catalogCode ? ` · ${rule.catalogCode}` : ' · whole state'}
            </strong>{' '}
            — {rule.status === 'blocked' ? 'not available' : 'cleared'}
            <br />
            <span className="muted">{rule.reason}</span>
            <br />
            {liftingId === rule.id ? (
              <>
                <Reason value={reason} onChange={setReason} />
                <button
                  className="btn btn--secondary"
                  type="button"
                  disabled={busy || reason.trim().length < MIN_REASON_LENGTH}
                  onClick={async () => {
                    const ok = await call('PATCH', { ruleId: rule.id, reason })
                    if (ok) {
                      setLiftingId(null)
                      setReason('')
                    }
                  }}
                >
                  {busy ? 'Lifting...' : 'Confirm lift'}
                </button>{' '}
                <button
                  className="btn btn--link"
                  type="button"
                  onClick={() => {
                    setLiftingId(null)
                    setReason('')
                  }}
                >
                  Cancel
                </button>
              </>
            ) : (
              <button className="btn btn--link" type="button" onClick={() => setLiftingId(rule.id)}>
                Lift this
              </button>
            )}
          </li>
        ))}
      </ul>
    </>
  )
}

export function PostureControl({ posture }: { posture: 'open' | 'allowlist' }) {
  const { error, busy, call } = useJurisdiction()
  const [reason, setReason] = useState('')
  const [confirming, setConfirming] = useState(false)

  const next = posture === 'open' ? 'allowlist' : 'open'

  return (
    <>
      {error ? <Alert kind="error">{error}</Alert> : null}

      <p>
        Currently <strong>{posture === 'open' ? 'open' : 'allowlist'}</strong>.{' '}
        {posture === 'open'
          ? 'The platform operates in every state except those blocked above.'
          : 'The platform operates ONLY in states explicitly cleared above.'}
      </p>

      {!confirming ? (
        <button className="btn btn--secondary" type="button" onClick={() => setConfirming(true)}>
          Switch to {next}
        </button>
      ) : (
        <>
          <Alert kind="error">
            {next === 'allowlist'
              ? 'This closes every state that has not been explicitly cleared. If nothing is cleared, nobody in the country can subscribe.'
              : 'This opens every state that is not explicitly blocked.'}
          </Alert>
          <Reason value={reason} onChange={setReason} />
          <button
            className="btn btn--danger"
            type="button"
            disabled={busy || reason.trim().length < MIN_REASON_LENGTH}
            onClick={async () => {
              const ok = await call('PATCH', { posture: next, reason })
              if (ok) {
                setConfirming(false)
                setReason('')
              }
            }}
          >
            {busy ? 'Switching...' : `Switch to ${next}`}
          </button>{' '}
          <button className="btn btn--link" type="button" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </>
      )}
    </>
  )
}
