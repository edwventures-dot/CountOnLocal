/**
 * Pre-launch route gate, and session refresh.
 *
 * Next.js 16 renamed Middleware to Proxy; this file must be named proxy.ts
 * and sit beside app/. A middleware.ts here would be silently ignored,
 * which for a file whose job is closing routes would be the worst possible
 * failure mode -- it would look installed and do nothing.
 *
 * The gate decision lives in src/lib/prelaunch.ts so it can be unit tested.
 * This file only wires it to the request.
 *
 * ## Two jobs, in this order
 *
 * The gate runs first. A refused route must not have its session refreshed
 * on the way to a 404 -- doing the work before deciding whether to answer
 * would hand an unauthenticated prober a round trip to the auth server for
 * every path they try.
 *
 * Session refresh runs second, and only on paths that are answering.
 * Supabase's access tokens are short-lived and the refresh token lives in a
 * cookie; something has to spend it and write the new pair back. A Server
 * Component cannot -- cookies are read-only there, which is why
 * createSupabaseServerClient swallows the write and leaves a comment
 * pointing here. Without this, a signed-in user is signed out again roughly
 * an hour later with no explanation.
 */

import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { prelaunchAllows, prelaunchGateEnabled } from '@/lib/prelaunch'

/**
 * Requests a suspended account may still make.
 *
 * Reporting a safety concern, specifically. Somebody suspended last week
 * who witnesses something dangerous today must still be able to say so --
 * blocking that would make a moderation decision into a gag, and the
 * report is about somebody else.
 */
const ALLOWED_WHILE_SUSPENDED = new Set(['/api/v1/incidents'])

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export async function proxy(request: NextRequest) {
  if (prelaunchGateEnabled(process.env) && !prelaunchAllows(request.nextUrl.pathname)) {
    // 404, not 403 -- see the note in prelaunch.ts. Rewriting rather than
    // redirecting keeps the URL as the visitor typed it.
    return new NextResponse(null, { status: 404 })
  }

  const response = await refreshSession(request)

  const blocked = await refusedForSuspension(request)
  return blocked ?? response
}

/**
 * Stops a suspended or closed account taking any action.
 *
 * ## Why here and not in each route
 *
 * users.status existed from migration 0001 and nothing read it. Adding the
 * check to guard() covered six routes; twenty-five more authenticate
 * directly, and the twenty-sixth would have forgotten. A suspension that
 * depends on every future route remembering is not a suspension.
 *
 * Mutating methods only. A suspended person can still read their own pages
 * -- they need to, to find out what happened -- and a GET cannot take work,
 * charge anybody, or send a message.
 *
 * Costs one indexed lookup on requests that change something. Reads, which
 * are almost all of them, are untouched.
 */
async function refusedForSuspension(request: NextRequest): Promise<NextResponse | null> {
  if (!MUTATING.has(request.method)) return null
  if (!request.nextUrl.pathname.startsWith('/api/')) return null
  if (ALLOWED_WHILE_SUSPENDED.has(request.nextUrl.pathname)) return null

  const url = process.env['NEXT_PUBLIC_SUPABASE_URL']
  const anonKey = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']
  if (!url || !anonKey) return null

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll()
      },
      setAll() {
        // Read-only pass. The refresh above already wrote any new cookies.
      },
    },
  })

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  // Row level security scopes this to the caller's own row.
  const { data: row } = await supabase.from('users').select('status').maybeSingle()
  if (!row || row.status === 'active') return null

  return NextResponse.json(
    {
      error: {
        code: 'ACCOUNT_NOT_ACTIVE',
        message:
          row.status === 'closed'
            ? 'This account has been closed. Contact support if you think that is wrong.'
            : 'This account is suspended while we look into a report.',
      },
    },
    { status: 403 },
  )
}

async function refreshSession(request: NextRequest): Promise<NextResponse> {
  const url = process.env['NEXT_PUBLIC_SUPABASE_URL']
  const anonKey = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']

  // Nothing to refresh without a configured project, and throwing here
  // would take down every route including the landing page.
  if (!url || !anonKey) return NextResponse.next({ request })

  let response = NextResponse.next({ request })

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll()
      },
      setAll(cookiesToSet) {
        // Written to both: the request so anything downstream in this same
        // pass sees the new token, and the response so the browser keeps it.
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value)
        }
        response = NextResponse.next({ request })
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options)
        }
      },
    },
  })

  // getUser, not getSession. getSession reads the cookie and believes it;
  // getUser asks the auth server, so a revoked or forged token does not
  // survive this call. On a path that decides what a browser may see, the
  // round trip is the point.
  await supabase.auth.getUser()

  return response
}

export const config = {
  /**
   * Skip Next's own internals and static files so neither the gate nor the
   * refresh intercepts the assets a page needs to render.
   */
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?)$).*)',
  ],
}
