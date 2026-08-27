'use client'

/**
 * Sign in and sign up.
 *
 * One component for both, because the two forms differ by a single rule --
 * signing up checks the credential policy before submitting, signing in
 * never should. A sign-in form that told you your password was too short
 * would be telling you about the password you just typed, not the one on
 * the account, which is both useless and a hint.
 *
 * ## Why the browser talks to Supabase directly
 *
 * There is no /api/v1/signin. The session lives in cookies that the
 * Supabase client writes, so routing sign-in through our own endpoint would
 * mean re-implementing that cookie handling for no gain. Our API sits
 * behind the session; it does not issue it.
 *
 * ## What the failure messages do and do not say
 *
 * On sign-in, a wrong password and an address with no account both produce
 * the same sentence. Distinguishing them turns the form into a way to test
 * whether a given person has an account here -- which on a platform whose
 * users are frequently minors is a worse leak than it would be elsewhere.
 *
 * Sign-up has the same hole and the processor's own message says the quiet
 * part out loud, so nothing it returns is ever shown directly.
 * interpretSignupError collapses "already registered" into the same notice
 * a brand new address gets, and the no-identities case below is the same
 * situation arriving as a success rather than an error.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabaseBrowser } from '@/lib/supabase/browser'
import {
  checkSignupCredentials,
  interpretSignupError,
  normalizeEmail,
  safeNextPath,
  SIGNUP_CONFIRMATION_NOTICE,
} from '@/domain/credentials'
import { Alert, Field } from '@/components/ui'

type Mode = 'signin' | 'signup'

export function AuthForm({ mode, next }: { mode: Mode; next?: string | undefined }) {
  // Validated rather than trusted: `next` comes from whoever wrote the
  // link. safeNextPath refuses anything that leaves the site.
  const destination = safeNextPath(next)
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setNotice(null)

    if (mode === 'signup') {
      // The same pure check the server would apply. Running it here saves a
      // round trip; it is not the only place it runs.
      const check = checkSignupCredentials({ email, password })
      if (!check.ok) {
        setError(check.message)
        return
      }
    }

    setBusy(true)
    try {
      const supabase = supabaseBrowser()
      const credentials = { email: normalizeEmail(email), password }

      if (mode === 'signup') {
        const { data, error: signUpError } = await supabase.auth.signUp(credentials)

        if (signUpError) {
          const outcome = interpretSignupError(signUpError.message)
          if (outcome.kind === 'confirm') setNotice(outcome.message)
          else setError(outcome.message)
          return
        }

        // A user with no identities is how Supabase reports an address that
        // is already taken when email confirmation is on -- a success shape
        // carrying a refusal. Treated identically to the error path above,
        // which is what keeps the two indistinguishable.
        if (data.user && (data.user.identities?.length ?? 0) === 0) {
          setNotice(SIGNUP_CONFIRMATION_NOTICE)
          return
        }

        // No session means confirmation is required. Say so rather than
        // bouncing to a page that will send them straight back.
        if (!data.session) {
          setNotice(SIGNUP_CONFIRMATION_NOTICE)
          return
        }
      } else {
        const { error: signInError } = await supabase.auth.signInWithPassword(credentials)
        if (signInError) {
          setError('That email address and password do not match an account.')
          return
        }
      }

      // refresh() so the server components re-render against the new
      // cookies; push() alone can show a cached signed-out shell.
      router.refresh()
      router.push(destination)
    } catch {
      setError('We could not reach the server. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="stack" noValidate>
      {error ? <Alert kind="error">{error}</Alert> : null}
      {notice ? <Alert kind="success">{notice}</Alert> : null}

      <Field
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />

      <Field
        label="Password"
        name="password"
        type="password"
        // Tells a password manager to offer a new one rather than to fill
        // the old one in.
        autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        {...(mode === 'signup' ? { hint: 'At least 10 characters. A few words together works well.' } : {})}
      />

      <button className="btn btn--full" type="submit" disabled={busy}>
        {busy ? 'Working…' : mode === 'signup' ? 'Create account' : 'Sign in'}
      </button>
    </form>
  )
}
