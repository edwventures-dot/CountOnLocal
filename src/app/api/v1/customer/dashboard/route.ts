/**
 * GET /v1/customer/dashboard
 *
 * PRD section 16's list in one call: next service, active subscriptions,
 * service history, and credits.
 *
 * Read through the caller's own client. RLS decides what comes back --
 * subscriptions_read_customer and occurrences_read_party -- so a mistake in
 * this file cannot return somebody else's schedule. There is no customer id
 * parameter because there is nothing to pass: a customer reading their own
 * dashboard is the only interpretation, unlike the provider route where the
 * same rows are visible in two roles.
 *
 * Not included yet, and deliberately not stubbed: provider messages
 * (step 9), report-an-issue (step 10) and reviews (step 9). An empty array
 * for a feature that does not exist would look like a feature with no data.
 */

import { authenticate } from '@/server/auth'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { standingCreditCents, type LedgerEntry } from '@/domain/ledger'
import { LIVE_SUBSCRIPTION_STATES, type SubscriptionState } from '@/domain/subscription'
import { DELIVERED_STATES, type OccurrenceState } from '@/domain/occurrence'
import { apiError, apiOk, newRequestId } from '@/lib/http'

export const dynamic = 'force-dynamic'

/** How much history to return before a client should ask for more. */
const HISTORY_LIMIT = 50

export async function GET(): Promise<Response> {
  const requestId = newRequestId()

  const auth = await authenticate()
  if (!auth.ok) {
    return apiError('UNAUTHENTICATED', 'Sign in to continue.', 401, { requestId })
  }

  const db = await createSupabaseServerClient()

  const { data: subs, error } = await db
    .from('subscriptions')
    .select(
      `id, state, provider_price_cents, price_unit, billing_cycle_weeks,
       platform_fee_bps, current_cycle_start, current_cycle_end, created_at,
       provider_services!inner (
         public_name,
         businesses!inner ( name, slug )
       ),
       customer_addresses!inner ( line1, city, region, postal_code )`,
    )
    .eq('customer_user_id', auth.auth.userId)
    .order('created_at', { ascending: false })

  if (error) {
    console.error('[dashboard] subscription query failed', error.message)
    return apiError('QUERY_FAILED', 'Could not load your dashboard.', 500, { requestId })
  }

  const one = <T,>(v: unknown): T | undefined => (Array.isArray(v) ? v[0] : v) as T | undefined

  const subscriptionIds = (subs ?? []).map((s) => s.id)

  // Occurrences and ledger for every subscription at once, rather than a
  // query per subscription -- a customer with six subscriptions should not
  // cost thirteen round trips.
  const [{ data: occRows }, { data: ledgerRows }] = await Promise.all([
    subscriptionIds.length
      ? db
          .from('service_occurrences')
          .select('id, subscription_id, service_date, state, service_value_cents')
          .in('subscription_id', subscriptionIds)
          .order('service_date', { ascending: true })
      : Promise.resolve({ data: [] as never[] }),
    // Privileged, and only for this.
    //
    // ledger_entries is revoked from `authenticated` with no policy, which
    // is right: a row carries provider earnings, the platform fee and a
    // processor id, and none of that is the customer's to read. Reading it
    // through the user-scoped client returned nothing at all -- no error,
    // just an empty set -- so every customer's credit balance displayed as
    // zero however much they were owed.
    //
    // Authorization is already established: subscriptionIds came from a
    // user-scoped query above, so row level security has confirmed the
    // caller owns every one of them. Only the aggregate leaves this file.
    subscriptionIds.length
      ? supabaseAdmin()
          .from('ledger_entries')
          .select('subscription_id, kind, amount_cents')
          .in('subscription_id', subscriptionIds)
      : Promise.resolve({ data: [] as never[] }),
  ])

  const occurrences = occRows ?? []
  const ledger = ledgerRows ?? []

  const todayIso = new Date().toISOString().slice(0, 10)

  const creditBySubscription = new Map<string, number>()
  for (const id of subscriptionIds) {
    const entries = ledger
      .filter((l) => l.subscription_id === id)
      .map((l) => ({ kind: l.kind, amountCents: l.amount_cents, currency: 'USD' })) as LedgerEntry[]
    creditBySubscription.set(id, standingCreditCents(entries))
  }

  const subscriptions = (subs ?? []).map((s) => {
    const svc = one<{ public_name: string; businesses: unknown }>(s.provider_services)
    const biz = one<{ name: string; slug: string }>(svc?.businesses)
    const addr = one<{ line1: string; city: string; region: string; postal_code: string }>(
      s.customer_addresses,
    )

    const mine = occurrences.filter((o) => o.subscription_id === s.id)
    const upcoming = mine.filter(
      (o) => o.service_date >= todayIso && (o.state === 'scheduled' || o.state === 'due_today'),
    )

    return {
      id: s.id,
      state: s.state as SubscriptionState,
      live: LIVE_SUBSCRIPTION_STATES.has(s.state as SubscriptionState),
      businessName: biz?.name ?? null,
      businessSlug: biz?.slug ?? null,
      serviceName: svc?.public_name ?? null,
      address: addr
        ? { line1: addr.line1, city: addr.city, region: addr.region, postalCode: addr.postal_code }
        : null,
      priceCents: s.provider_price_cents,
      priceUnit: s.price_unit,
      billingCycleWeeks: s.billing_cycle_weeks,
      currentCycle: { start: s.current_cycle_start, end: s.current_cycle_end },
      creditCents: creditBySubscription.get(s.id) ?? 0,
      nextServiceDate: upcoming[0]?.service_date ?? null,
      upcomingCount: upcoming.length,
      // Ids, because skipping needs one. Bounded to the next few: a
      // customer acts on the visit in front of them, and returning the
      // whole horizon would put dozens of dates on a phone screen.
      upcoming: upcoming.slice(0, 4).map((o) => ({
        occurrenceId: o.id,
        serviceDate: o.service_date,
        state: o.state,
      })),
    }
  })

  // The single next visit across everything, which is what the top of the
  // page actually shows.
  const nextService = subscriptions
    .filter((s) => s.nextServiceDate !== null)
    .sort((a, b) => (a.nextServiceDate! < b.nextServiceDate! ? -1 : 1))[0]

  const history = occurrences
    .filter((o) => DELIVERED_STATES.has(o.state as OccurrenceState) || o.state === 'credited')
    .sort((a, b) => (a.service_date > b.service_date ? -1 : 1))
    .slice(0, HISTORY_LIMIT)
    .map((o) => ({
      occurrenceId: o.id,
      subscriptionId: o.subscription_id,
      serviceDate: o.service_date,
      state: o.state,
      valueCents: o.service_value_cents,
    }))

  return apiOk({
    nextService: nextService
      ? {
          subscriptionId: nextService.id,
          serviceDate: nextService.nextServiceDate,
          businessName: nextService.businessName,
          serviceName: nextService.serviceName,
        }
      : null,
    subscriptions,
    history,
    historyTruncated: history.length === HISTORY_LIMIT,
    totalCreditCents: [...creditBySubscription.values()].reduce((a, b) => a + b, 0),
  })
}
