/**
 * Pre-launch route gate.
 *
 * Next.js 16 renamed Middleware to Proxy; this file must be named proxy.ts
 * and sit beside app/. A middleware.ts here would be silently ignored,
 * which for a file whose job is closing routes would be the worst possible
 * failure mode -- it would look installed and do nothing.
 *
 * The decision itself lives in src/lib/prelaunch.ts so it can be unit
 * tested. This file only wires it to the request.
 */

import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { prelaunchAllows, prelaunchGateEnabled } from '@/lib/prelaunch'

export function proxy(request: NextRequest) {
  if (!prelaunchGateEnabled(process.env)) return NextResponse.next()

  if (prelaunchAllows(request.nextUrl.pathname)) return NextResponse.next()

  // 404, not 403 -- see the note in prelaunch.ts. Rewriting rather than
  // redirecting keeps the URL as the visitor typed it.
  return new NextResponse(null, { status: 404 })
}

export const config = {
  /**
   * Skip Next's own internals and static files so the gate never intercepts
   * the assets the landing page itself needs to render.
   */
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?)$).*)'],
}
