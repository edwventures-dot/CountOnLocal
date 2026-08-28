'use client'

/**
 * The accept button.
 *
 * Thin on purpose. Every decision -- is the token real, has it expired, is
 * this transition legal -- belongs to the API, which checks the token
 * against a hash it cannot reverse. This only reports the answer.
 *
 * The failure messages are the ones the endpoint returns. It already
 * refuses to distinguish a malformed token from a valid-looking one that
 * does not exist, so there is nothing to soften here.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Alert } from '@/components/ui'

type State =
  | { kind: 'ready' }
  | { kind: 'working' }
  | { kind: 'done' }
  | { kind: 'error'; message: string }

export function AcceptInvitation({ token }: { token: string }) {
  const router = useRouter()
  const [state, setState] = useState<State>({ kind: 'ready' })

  async function accept() {
    setState({ kind: 'working' })
    try {
      const res = await fetch(`/api/v1/guardian/invitations/${encodeURIComponent(token)}/accept`, {
        method: 'POST',
      })
      const body = await res.json().catch(() => ({}))

      if (!res.ok) {
        setState({
          kind: 'error',
          message: body?.error?.message ?? 'This invitation could not be accepted.',
        })
        return
      }

      setState({ kind: 'done' })
      router.refresh()
    } catch {
      setState({ kind: 'error', message: 'We could not reach the server. Please try again.' })
    }
  }

  if (state.kind === 'done') {
    return (
      <div className="stack">
        <Alert kind="success">You are now connected as their guardian.</Alert>
        <p className="muted">
          They still cannot take a paying customer until your identity is confirmed. We will email
          you when that step is ready.
        </p>
        <a className="btn btn--full" href="/guardian">
          See what they are doing
        </a>
      </div>
    )
  }

  return (
    <div className="stack">
      {state.kind === 'error' ? <Alert kind="error">{state.message}</Alert> : null}

      <p className="muted" style={{ marginBottom: 0 }}>
        Approving means you agree to be the responsible adult for this account. You can see what
        they are doing, and you can withdraw your approval at any time — which stops new customers
        and stops charges immediately.
      </p>

      <button className="btn btn--full" type="button" onClick={accept} disabled={state.kind === 'working'}>
        {state.kind === 'working' ? 'Working…' : 'Approve this account'}
      </button>
    </div>
  )
}
