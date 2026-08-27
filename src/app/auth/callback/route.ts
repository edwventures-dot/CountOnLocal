/**
 * GET /auth/callback
 *
 * Where a link in an auth email lands: confirming an address, or a
 * password reset. Supabase sends the browser here with either a `code` to
 * exchange (the PKCE flow) or a `token_hash` and `type` to verify (the
 * older OTP flow). Both are handled, because which one arrives depends on
 * how the project's email templates are written, and a template edited
 * later should not silently break confirmation.
 *
 * Exchanging happens server-side through the cookie-writing client, so a
 * confirmed visitor arrives already signed in rather than being asked for
 * the password they just set up.
 *
 * ## The redirect target is not trusted
 *
 * `next` is read from the query string, which came from a link in an
 * email. safeNextPath keeps it on this site -- see the note there about
 * why that matters more on an auth flow than almost anywhere else.
 *
 * ## Failures say little
 *
 * An expired link, a reused link and a forged one all land on the same
 * page with the same message. Distinguishing them would tell somebody
 * holding a stale link whether the address it belongs to has an account.
 */

import { NextResponse } from 'next/server'
import type { EmailOtpType } from '@supabase/supabase-js'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { safeNextPath } from '@/domain/credentials'

export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const next = safeNextPath(url.searchParams.get('next'))

  const code = url.searchParams.get('code')
  const tokenHash = url.searchParams.get('token_hash')
  const type = url.searchParams.get('type') as EmailOtpType | null

  const db = await createSupabaseServerClient()

  if (code) {
    const { error } = await db.auth.exchangeCodeForSession(code)
    if (!error) return NextResponse.redirect(new URL(next, url.origin))
  } else if (tokenHash && type) {
    const { error } = await db.auth.verifyOtp({ type, token_hash: tokenHash })
    if (!error) return NextResponse.redirect(new URL(next, url.origin))
  }

  // One destination for every way this can fail.
  return NextResponse.redirect(new URL('/signin?problem=link', url.origin))
}
