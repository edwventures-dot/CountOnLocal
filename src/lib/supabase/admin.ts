/**
 * Privileged Supabase client.
 *
 * Uses the service role key and therefore BYPASSES row level security.
 *
 * Reach for this only where a request legitimately acts outside any one
 * user's visibility -- writing the append-only audit log, resolving a
 * guardian invitation token before anyone is authenticated, or a background
 * job. Every other path uses createSupabaseServerClient() so RLS stays in
 * force.
 *
 * TECHNICAL_SPEC section 3: "Authorization must be enforced server-side."
 * Using this client is a decision to do that enforcement by hand, in the
 * caller, rather than letting the database do it.
 */

import { createClient } from '@supabase/supabase-js'
import type { Database } from './types'
import { publicEnv, serverEnv } from '@/lib/env'

let cached: ReturnType<typeof createClient<Database>> | undefined

export function supabaseAdmin() {
  if (typeof window !== 'undefined') {
    throw new Error('supabaseAdmin() is server-only. The service role key must never reach a browser.')
  }
  if (cached) return cached
  cached = createClient<Database>(publicEnv().NEXT_PUBLIC_SUPABASE_URL, serverEnv().SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return cached
}
