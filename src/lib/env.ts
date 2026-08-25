/**
 * Environment validation.
 *
 * Split deliberately into public and server halves. The service role key
 * bypasses row level security, so it is read through a function that throws
 * if it is ever reached from browser code -- TECHNICAL_SPEC section 16
 * requires privileged credentials to stay separate from public frontend
 * keys, and a thrown error at build time beats discovering the leak later.
 */

import { z } from 'zod'

const publicSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  /**
   * Where Stripe sends the holder back after onboarding.
   *
   * Configured server-side rather than accepted from the request, so a
   * caller cannot turn the onboarding flow into an open redirect.
   */
  NEXT_PUBLIC_APP_URL: z.string().url().default('http://localhost:3100'),
})

const serverSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  AUDIT_IP_HASH_SALT: z.string().min(16, 'Use a long random salt'),
  STRIPE_SECRET_KEY: z.string().min(1),
  // Empty until a webhook endpoint exists; validated where it is used.
  STRIPE_WEBHOOK_SECRET: z.string().default(''),
})

export type PublicEnv = z.infer<typeof publicSchema>
export type ServerEnv = z.infer<typeof serverSchema>

let cachedPublic: PublicEnv | undefined
let cachedServer: ServerEnv | undefined

export function publicEnv(): PublicEnv {
  if (cachedPublic) return cachedPublic
  const parsed = publicSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env['NEXT_PUBLIC_SUPABASE_URL'],
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'],
    NEXT_PUBLIC_APP_URL: process.env['NEXT_PUBLIC_APP_URL'] ?? 'http://localhost:3100',
  })
  if (!parsed.success) {
    throw new Error('Missing or invalid public Supabase environment. See .env.example')
  }
  cachedPublic = parsed.data
  return cachedPublic
}

export function serverEnv(): ServerEnv {
  if (typeof window !== 'undefined') {
    throw new Error('serverEnv() was called from the browser. Privileged keys are server-only.')
  }
  if (cachedServer) return cachedServer
  const parsed = serverSchema.safeParse({
    SUPABASE_SERVICE_ROLE_KEY: process.env['SUPABASE_SERVICE_ROLE_KEY'],
    AUDIT_IP_HASH_SALT: process.env['AUDIT_IP_HASH_SALT'],
    STRIPE_SECRET_KEY: process.env['STRIPE_SECRET_KEY'],
    STRIPE_WEBHOOK_SECRET: process.env['STRIPE_WEBHOOK_SECRET'] ?? '',
  })
  if (!parsed.success) {
    throw new Error('Missing or invalid server environment. See .env.example')
  }
  cachedServer = parsed.data
  return cachedServer
}
