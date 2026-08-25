/**
 * Stripe client. Server-only.
 *
 * The secret key can create charges and move money, so this module throws
 * if it is ever imported into browser code -- the same guard as the
 * Supabase service role client.
 */

import Stripe from 'stripe'
import { serverEnv } from '@/lib/env'

let cached: Stripe | undefined

export function stripe(): Stripe {
  if (typeof window !== 'undefined') {
    throw new Error('stripe() is server-only. The secret key must never reach a browser.')
  }
  if (cached) return cached
  cached = new Stripe(serverEnv().STRIPE_SECRET_KEY, {
    // Pinning avoids a Stripe-side API upgrade silently changing behaviour
    // in a money path.
    apiVersion: '2026-07-29.dahlia',
    appInfo: { name: 'Count On Local' },
  })
  return cached
}

export function isTestMode(): boolean {
  return serverEnv().STRIPE_SECRET_KEY.includes('_test_')
}
