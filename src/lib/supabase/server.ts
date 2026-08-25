/**
 * Request-scoped Supabase client.
 *
 * Uses the anon key and carries the caller's session, so row level security
 * applies. This is the client almost everything should use: it can only see
 * what the signed-in user is allowed to see.
 */

import { createServerClient } from '@supabase/ssr'
import type { Database } from './types'
import { cookies } from 'next/headers'
import { publicEnv } from '@/lib/env'

export async function createSupabaseServerClient() {
  const cookieStore = await cookies()
  const env = publicEnv()

  return createServerClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options)
          }
        } catch {
          // Called from a Server Component, where cookies are read-only.
          // Session refresh is handled in middleware instead.
        }
      },
    },
  })
}
