/**
 * POST /api/webhooks/stripe
 *
 * TECHNICAL_SPEC section 11: verify signatures, persist raw event metadata,
 * de-duplicate by external event ID, support replay, and never assume
 * ordering.
 *
 * Ordering is handled by not depending on it. Rather than applying a delta
 * carried in the event, every relevant event triggers a fresh read of the
 * account from Stripe. A stale event that arrives late therefore produces
 * the same result as a fresh one, and two events arriving out of order both
 * converge on the truth instead of one overwriting the other with older
 * data.
 */

import { stripe } from '@/lib/stripe'
import { serverEnv } from '@/lib/env'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { syncAccountState } from '@/server/connectOnboarding'

/**
 * Event types that change whether money can move. Anything else is recorded
 * and acknowledged without a Stripe round trip.
 */
const ACCOUNT_EVENT_PREFIXES = ['v2.core.account', 'account.updated', 'account.application']

function namesAnAccount(type: string): boolean {
  return ACCOUNT_EVENT_PREFIXES.some((p) => type.startsWith(p))
}

/** v2 thin events carry a related_object; v1 events carry the object inline. */
function extractAccountId(event: Record<string, unknown>): string | null {
  const related = event['related_object'] as { id?: string; type?: string } | undefined
  if (related?.id && String(related.id).startsWith('acct_')) return related.id

  const onAccount = event['account']
  if (typeof onAccount === 'string' && onAccount.startsWith('acct_')) return onAccount

  const data = event['data'] as { object?: { id?: string; object?: string } } | undefined
  const obj = data?.object
  if (obj?.object === 'account' && typeof obj.id === 'string') return obj.id

  return null
}

export async function POST(req: Request): Promise<Response> {
  const secret = serverEnv().STRIPE_WEBHOOK_SECRET
  if (!secret) {
    // Refusing loudly beats silently accepting unverified webhooks, which
    // would let anyone who can reach this URL move payout state.
    console.error('[stripe-webhook] STRIPE_WEBHOOK_SECRET is not set; refusing')
    return new Response('Webhook secret not configured', { status: 500 })
  }

  const signature = req.headers.get('stripe-signature')
  if (!signature) return new Response('Missing signature', { status: 400 })

  // Signature is computed over the exact bytes, so the raw body is read
  // before anything parses it.
  const raw = await req.text()

  // Stripe sends two shapes on the same endpoint. v2 "thin" event
  // notifications carry only a reference to the changed object; v1 webhooks
  // embed the object. The SDK refuses to parse one as the other, so try the
  // v2 parser first and fall back. Both verify the same HMAC signature, so a
  // forged payload fails either way.
  let event: Record<string, unknown>
  try {
    event = stripe().parseEventNotification(raw, signature, secret) as unknown as Record<
      string,
      unknown
    >
  } catch {
    try {
      event = stripe().webhooks.constructEvent(raw, signature, secret) as unknown as Record<
        string,
        unknown
      >
    } catch (err) {
      console.error('[stripe-webhook] signature verification failed', (err as Error).message)
      return new Response('Invalid signature', { status: 400 })
    }
  }

  const db = supabaseAdmin()
  const eventId = String(event['id'] ?? '')
  const type = String(event['type'] ?? 'unknown')
  const accountId = extractAccountId(event)

  // The primary key does the de-duplication. A conflict means Stripe is
  // retrying something already handled, which is a success, not an error.
  const { error: insertError } = await db.from('stripe_events').insert({
    id: eventId,
    type,
    account_id: accountId,
    api_version: typeof event['api_version'] === 'string' ? event['api_version'] : null,
    payload: event,
  })

  if (insertError) {
    if (insertError.code === '23505') {
      return Response.json({ received: true, duplicate: true })
    }
    console.error('[stripe-webhook] could not record event', insertError.message)
    // 500 so Stripe retries: an event we failed to record is one we cannot
    // prove we handled.
    return new Response('Could not record event', { status: 500 })
  }

  let handlerError: string | null = null

  if (accountId && namesAnAccount(type)) {
    // Confirm we actually hold this account before spending a Stripe call on
    // it. A platform receives events for accounts it does not own -- other
    // environments sharing a key, accounts created outside this app -- and
    // calling retrieve() on those produces an error that looks like a
    // failure worth retrying when it is simply not our business.
    const { data: held } = await db
      .from('users')
      .select('id')
      .eq('stripe_connected_account_id', accountId)
      .maybeSingle()

    if (held) {
      const synced = await syncAccountState({ db, accountId, now: new Date() })
      if (!synced.ok) handlerError = synced.code
    }
  }

  await db
    .from('stripe_events')
    .update({ processed_at: new Date().toISOString(), error: handlerError })
    .eq('id', eventId)

  if (handlerError) {
    return new Response('Handler failed', { status: 500 })
  }

  return Response.json({ received: true })
}
