/**
 * The Grow screen's data.
 *
 * UX_UI_SPEC section 13 calls this screen strategically important, and the
 * reason is PRD section 14: the platform optimises for revenue per local
 * route rather than map radius. This assembles the numbers that make that
 * argument to a provider, and the one prompt worth acting on.
 *
 * The prompt logic and the privacy thresholds are in domain/density.ts.
 * This does the queries.
 */

import { randomBytes } from 'node:crypto'
import {
  earningsPerHourCents,
  growthPrompt,
  referralCodeFrom,
  routeDensity,
  socialProof,
  type GrowthPrompt,
  type RouteDensity,
} from '@/domain/density'
import { orderRoute, type RouteStop } from '@/domain/route'
import { parsePostgisPoint } from '@/lib/geo'
import { shareUrl } from '@/server/flyerService'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'

type Db = SupabaseClient<Database>

export type GrowServiceView = {
  serviceId: string
  publicName: string
  density: RouteDensity
  prompt: GrowthPrompt
  /** Provider earnings for one full cycle of this route, in cents. */
  routeValueCents: number
  estimatedMinutes: number
  /** Null when there is nothing to divide by. Never a confident zero. */
  earningsPerHourCents: number | null
  /** What the storefront is allowed to say. Withheld below the threshold. */
  publicSocialProof: string | null
}

export type GrowDashboard = {
  businessName: string
  storefrontUrl: string
  shareUrl: string
  referralCode: string | null
  services: GrowServiceView[]
}

export type GrowResult =
  | { ok: true; dashboard: GrowDashboard }
  | { ok: false; code: 'NO_BUSINESS' | 'QUERY_FAILED'; message: string }

const SITE_ORIGIN = 'https://countonlocal.com'

export async function getGrowDashboard(args: {
  db: Db
  providerUserId: string
}): Promise<GrowResult> {
  const { db, providerUserId } = args

  const { data: biz, error } = await db
    .from('businesses')
    .select('id, name, slug, public_area_label')
    .eq('provider_user_id', providerUserId)
    .maybeSingle()

  if (error) {
    console.error('[grow] business query failed', error.message)
    return { ok: false, code: 'QUERY_FAILED', message: 'Could not load this screen.' }
  }
  if (!biz) {
    return { ok: false, code: 'NO_BUSINESS', message: 'Create your business first.' }
  }

  const { data: services } = await db
    .from('provider_services')
    .select('id, public_name, price_cents, price_unit, billing_cycle_weeks, capacity_rule')
    .eq('business_id', biz.id)
    .eq('state', 'active')

  const serviceIds = (services ?? []).map((s) => s.id)

  // Active subscriptions and their addresses in one pass. A provider with
  // three services should not cost six round trips.
  const { data: subs } = serviceIds.length
    ? await db
        .from('subscriptions')
        .select(
          `id, provider_service_id, provider_price_cents,
           customer_addresses!inner ( point )`,
        )
        .in('provider_service_id', serviceIds)
        .eq('state', 'active')
    : { data: [] as never[] }

  const one = <T,>(v: unknown): T | undefined => (Array.isArray(v) ? v[0] : v) as T | undefined

  const views: GrowServiceView[] = (services ?? []).map((s) => {
    const mine = (subs ?? []).filter((sub) => sub.provider_service_id === s.id)

    const capacityRaw = (s.capacity_rule as Record<string, unknown> | null)?.['maxAddresses']
    const capacity = Number.isFinite(Number(capacityRaw)) ? Number(capacityRaw) : 0

    const density = routeDensity({ activeCustomers: mine.length, capacity })

    // Route length from the same ordering the Today screen uses, so the
    // two screens cannot quote different numbers for the same walk.
    const stops: RouteStop[] = mine.map((sub) => {
      const addr = one<{ point: unknown }>(sub.customer_addresses)
      return { occurrenceId: sub.id, point: parsePostgisPoint(addr?.point) }
    })
    const ordered = orderRoute({ stops })

    // One visit each, which is what a single route day is worth.
    const routeValueCents = mine.reduce((sum, sub) => sum + sub.provider_price_cents, 0)

    const proof = socialProof({
      activeCustomers: density.activeCustomers,
      ...(biz.public_area_label ? { areaLabel: biz.public_area_label } : {}),
    })

    return {
      serviceId: s.id,
      publicName: s.public_name,
      density,
      prompt: growthPrompt({
        density,
        ...(biz.public_area_label ? { areaLabel: biz.public_area_label } : {}),
      }),
      routeValueCents,
      estimatedMinutes: ordered.estimatedMinutes,
      earningsPerHourCents: earningsPerHourCents({
        routeValueCents,
        estimatedMinutes: ordered.estimatedMinutes,
      }),
      publicSocialProof: proof.show ? proof.label : null,
    }
  })

  const referralCode = await ensureReferralCode({ db, providerUserId })
  const storefrontUrl = `${SITE_ORIGIN}/${biz.slug}`

  return {
    ok: true,
    dashboard: {
      businessName: biz.name,
      storefrontUrl,
      shareUrl: shareUrl({
        storefrontUrl,
        ...(referralCode ? { referralCode } : {}),
      }),
      referralCode,
      services: views,
    },
  }
}

/**
 * The provider's live referral code, minting one if they have none.
 *
 * `db` must be the PRIVILEGED client to mint: 0022 allows no client writes.
 * A collision on the primary key is retried rather than surfaced -- eight
 * characters from a 31-letter alphabet makes one vanishingly unlikely, and
 * a provider should never see an error for it.
 */
export async function ensureReferralCode(args: {
  db: Db
  providerUserId: string
}): Promise<string | null> {
  const { db, providerUserId } = args

  const { data: existing } = await db
    .from('referral_codes')
    .select('code')
    .eq('provider_user_id', providerUserId)
    .is('revoked_at', null)
    .maybeSingle()

  if (existing) return existing.code

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = referralCodeFrom(randomBytes(16))
    const { error } = await db
      .from('referral_codes')
      .insert({ code, provider_user_id: providerUserId })

    if (!error) return code

    // 23505 is either a code collision -- retry -- or the one-live-code
    // index, which means a parallel request just minted one. Either way,
    // look again rather than failing.
    if (error.code === '23505') {
      const { data: raced } = await db
        .from('referral_codes')
        .select('code')
        .eq('provider_user_id', providerUserId)
        .is('revoked_at', null)
        .maybeSingle()
      if (raced) return raced.code
      continue
    }

    console.error('[grow] referral code mint failed', error.message)
    return null
  }

  return null
}
