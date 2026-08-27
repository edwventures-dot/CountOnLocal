'use client'

/**
 * Surfaces an auth error that arrived in the URL fragment.
 *
 * Supabase's own verify endpoint redirects to the Site URL and puts the
 * outcome after a `#`. A fragment is never sent to the server, so no route
 * handler can see it -- the page renders normally and the visitor is left
 * looking at a landing page with a wall of error text in the address bar
 * and no explanation on the page.
 *
 * That is how a working confirmation looked broken: the link had already
 * been spent, Supabase said so in the fragment, and nothing read it.
 *
 * Belt and braces. Once the email templates point at /auth/callback the
 * errors arrive as query parameters that the route handles properly, but
 * password recovery and any hand-written link can still land here.
 */

import { useEffect, useState } from 'react'
import { Alert } from '@/components/ui'

/** Supabase's codes, in words a person can act on. */
function explain(code: string | null, description: string | null): string {
  switch (code) {
    case 'otp_expired':
      return 'That link has expired or was already used. Links work once. Ask for a new one, or sign in with your password.'
    case 'access_denied':
      return 'That link is no longer valid. Ask for a new one, or sign in with your password.'
    default:
      // Supabase's own words, cleaned of the + signs a query encoder leaves
      // behind. Better than showing nothing when the code is unfamiliar.
      return description?.replace(/\+/g, ' ') ?? 'That link did not work. Please try again.'
  }
}

export function AuthFragmentNotice() {
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    const hash = window.location.hash
    if (!hash.includes('error')) return

    const params = new URLSearchParams(hash.replace(/^#/, ''))
    setMessage(explain(params.get('error_code'), params.get('error_description')))

    // Clear the fragment so a refresh does not show it again, and so the
    // address bar stops carrying a token-adjacent string around.
    window.history.replaceState(null, '', window.location.pathname + window.location.search)
  }, [])

  if (!message) return null

  return (
    <div style={{ maxWidth: 640, margin: '0 auto var(--space-5)', padding: '0 var(--space-4)' }}>
      <Alert kind="error">{message}</Alert>
    </div>
  )
}
