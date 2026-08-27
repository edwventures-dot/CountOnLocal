/**
 * Browser Supabase client.
 *
 * The third of three, and the only one that runs where a user can see it.
 * admin.ts bypasses RLS and is server-only; server.ts carries the caller's
 * session on the server; this one lets the browser sign in and out, which
 * is what writes the cookies the other two then read.
 *
 * Anon key only. It is public by design -- every table this key can reach
 * is protected by row level security, which is why verify-rls asserts that
 * anonymous reads are refused rather than trusting the key to stay secret.
 */

import { createBrowserClient } from '@supabase/ssr'
import type { Database } from './types'

let cached: ReturnType<typeof createBrowserClient<Database>> | undefined

export function supabaseBrowser() {
  if (cached) return cached

  // Read directly from process.env rather than through publicEnv(): these
  // are inlined at build time by Next, and a dynamic lookup would leave
  // them undefined in the bundle.
  cached = createBrowserClient<Database>(
    process.env['NEXT_PUBLIC_SUPABASE_URL']!,
    process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!,
  )
  return cached
}
