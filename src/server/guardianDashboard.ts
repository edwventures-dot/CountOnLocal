/**
 * What a guardian sees, and the one button they can always reach.
 *
 * PRD section 15 lists the view: the business and its public page, the
 * approved services, the service-area boundaries, the scheduled dates and
 * customer addresses tied to actual jobs, payout status, and an immediate
 * pause.
 *
 * ## Reading through the guardian's own client
 *
 * Every read here goes through the caller's session, so 0019's policies
 * decide what comes back. That migration draws the line PRD section 15 ends
 * on -- "Guardian cannot silently read unrelated private drafts or export
 * customer data for non-service purposes" -- in two tiers: consent data
 * (business, services, area) from guardian_started onward, operational data
 * (customers, addresses, visits) only once verified.
 *
 * So this file does not decide what a guardian may see. If a future edit
 * selects something it should not, the database refuses.
 *
 * ## Pausing is not revoking
 *
 * Revocation is a statement about the relationship: consent is withdrawn,
 * the state machine moves, and the business goes down with it. Pausing is a
 * statement about right now -- "stop, I want to look at this" -- and leaves
 * consent intact so it can be undone without re-running the whole guardian
 * flow.
 *
 * A guardian who has to revoke consent in order to pause for an afternoon
 * would either not pause when they should, or revoke when they did not mean
 * to. Both are worse than having two buttons.
 */

import type { OccurrenceState } from '@/domain/occurrence'
import { writeAudit } from '@/server/audit'
import { getPayoutStatus } from '@/server/connectOnboarding'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'

type Db = SupabaseClient<Database>

export type GuardianServiceView = {
  id: string
  publicName: string
  slug: string
  catalogCode: string | null
  priceCents: number
  priceUnit: string
  state: string
  /** Whether this guardian has approved the category it belongs to. */
  categoryApproved: boolean
  hasServiceArea: boolean
}

export type GuardianVisitView = {
  occurrenceId: string
  serviceDate: string
  state: OccurrenceState
  /** Null until the guardian is verified -- see 0019. */
  address: { line1: string; city: string; region: string; postalCode: string } | null
}

export type GuardianDashboard = {
  relationship: { id: string; state: string; provider: { firstName: string | null } }
  business: {
    id: string
    name: string
    slug: string
    state: string
    /** The page a neighbour would land on. */
    publicUrl: string
    isLive: boolean
    /** Findable in search, as opposed to reachable by link. */
    searchable: boolean
  } | null
  services: GuardianServiceView[]
  /** Upcoming scheduled work. Empty until verified. */
  upcoming: GuardianVisitView[]
  activeCustomerCount: number
  payout: { stage: string; canReceivePayments: boolean } | null
  /** True when this guardian can see operational data at all. */
  canSeeOperations: boolean
}

export type DashboardResult =
  | { ok: true; dashboard: GuardianDashboard }
  | { ok: false; code: 'NO_RELATIONSHIP' | 'QUERY_FAILED'; message: string }

/** Horizon shown on the dashboard. A guardian wants the next few weeks. */
const UPCOMING_LIMIT = 30

export async function getGuardianDashboard(args: {
  db: Db
  /**
   * Privileged client, used for two derived values only: the provider's
   * display first name and their payout stage.
   *
   * provider_profiles is readable only by its owner (0002), and widening
   * that policy would hand a guardian the whole row -- date of birth
   * included. PRD section 15 asks for a name and a payout status, not for
   * the profile, so those two are computed here after the relationship has
   * already been established from the guardian's own client. Everything
   * else on this dashboard still goes through `db` and RLS.
   */
  adminDb: Db
  guardianUserId: string
  /** Which relationship, when a guardian covers more than one provider. */
  relationshipId?: string | undefined
  /** Injected so the payout age checks are not clock-dependent. */
  now?: Date | undefined
}): Promise<DashboardResult> {
  const { db, guardianUserId } = args

  let query = db
    .from('guardian_relationships')
    .select('id, provider_user_id, state')
    .eq('guardian_user_id', guardianUserId)
    .order('created_at', { ascending: false })

  if (args.relationshipId) query = query.eq('id', args.relationshipId)

  const { data: rels, error: relError } = await query.limit(1)
  if (relError) {
    console.error('[guardian] relationship query failed', relError.message)
    return { ok: false, code: 'QUERY_FAILED', message: 'Could not load this dashboard.' }
  }

  const rel = rels?.[0]
  if (!rel) {
    return {
      ok: false,
      code: 'NO_RELATIONSHIP',
      message: 'This account is not connected to a provider.',
    }
  }

  // Operational visibility mirrors 0019. Computed here only to shape the
  // response; the database is what actually withholds the rows.
  const canSeeOperations = rel.state === 'verified' || rel.state === 'revoked'

  const { data: profile } = await args.adminDb
    .from('provider_profiles')
    .select('display_first_name')
    .eq('user_id', rel.provider_user_id)
    .maybeSingle()

  const { data: biz } = await db
    .from('businesses')
    .select('id, name, slug, state, searchable')
    .eq('provider_user_id', rel.provider_user_id)
    .maybeSingle()

  let services: GuardianServiceView[] = []
  let upcoming: GuardianVisitView[] = []
  let activeCustomerCount = 0

  if (biz) {
    const { data: approvals } = await db
      .from('guardian_service_approvals')
      .select('catalog_code')
      .eq('relationship_id', rel.id)
      .is('revoked_at', null)
    const approved = new Set((approvals ?? []).map((a) => a.catalog_code))

    const { data: svcRows } = await db
      .from('provider_services')
      .select(
        `id, public_name, slug, price_cents, price_unit, state,
         service_catalog!inner ( code ),
         service_areas ( id )`,
      )
      .eq('business_id', biz.id)

    const one = <T,>(v: unknown): T | undefined => (Array.isArray(v) ? v[0] : v) as T | undefined

    services = (svcRows ?? []).map((s) => {
      const cat = one<{ code: string }>(s.service_catalog)
      const areas = Array.isArray(s.service_areas) ? s.service_areas : s.service_areas ? [s.service_areas] : []
      return {
        id: s.id,
        publicName: s.public_name,
        slug: s.slug,
        catalogCode: cat?.code ?? null,
        priceCents: s.price_cents,
        priceUnit: s.price_unit,
        state: s.state,
        categoryApproved: cat ? approved.has(cat.code) : false,
        hasServiceArea: areas.length > 0,
      }
    })

    if (canSeeOperations) {
      const serviceIds = services.map((s) => s.id)

      if (serviceIds.length) {
        const { data: subs } = await db
          .from('subscriptions')
          .select('id, state')
          .in('provider_service_id', serviceIds)

        activeCustomerCount = (subs ?? []).filter((s) => s.state === 'active').length

        const subIds = (subs ?? []).map((s) => s.id)
        if (subIds.length) {
          const todayIso = new Date().toISOString().slice(0, 10)
          const { data: occs } = await db
            .from('service_occurrences')
            .select(
              `id, service_date, state,
               subscriptions!inner (
                 customer_addresses!inner ( line1, city, region, postal_code )
               )`,
            )
            .in('subscription_id', subIds)
            .gte('service_date', todayIso)
            .order('service_date', { ascending: true })
            .limit(UPCOMING_LIMIT)

          upcoming = (occs ?? []).map((o) => {
            const sub = one<{ customer_addresses: unknown }>(o.subscriptions)
            const addr = one<{
              line1: string
              city: string
              region: string
              postal_code: string
            }>(sub?.customer_addresses)
            return {
              occurrenceId: o.id,
              serviceDate: o.service_date,
              state: o.state as OccurrenceState,
              address: addr
                ? {
                    line1: addr.line1,
                    city: addr.city,
                    region: addr.region,
                    postalCode: addr.postal_code,
                  }
                : null,
            }
          })
        }
      }
    }
  }

  // Payout status is a state, not a transaction history. PRD section 15
  // gives a guardian "payout status"; the ledger stays closed to them, and
  // this returns the same two fields the provider's own status endpoint
  // does rather than a second, drifting version of the same idea.
  const payoutResult = await getPayoutStatus({
    db: args.adminDb,
    providerUserId: rel.provider_user_id,
    now: args.now ?? new Date(),
  })
  const payout = payoutResult.ok
    ? {
        stage: payoutResult.status.stage,
        canReceivePayments: payoutResult.status.canReceivePayments,
      }
    : null

  return {
    ok: true,
    dashboard: {
      relationship: {
        id: rel.id,
        state: rel.state,
        provider: { firstName: profile?.display_first_name ?? null },
      },
      business: biz
        ? {
            id: biz.id,
            name: biz.name,
            slug: biz.slug,
            state: biz.state,
            publicUrl: `https://countonlocal.com/${biz.slug}`,
            isLive: biz.state === 'published',
            searchable: biz.searchable,
          }
        : null,
      services,
      upcoming,
      activeCustomerCount,
      payout,
      canSeeOperations,
    },
  }
}

export type PauseResult =
  | { ok: true; state: 'paused_guardian' | 'published'; affectedOccurrences: number }
  | { ok: false; code: 'NOT_FOUND' | 'NOT_AUTHORIZED' | 'NOT_PAUSABLE' | 'WRITE_FAILED'; message: string }

/**
 * Stops the business now.
 *
 * The storefront comes down immediately, which is the point -- the gates
 * would already refuse a new checkout, but leaving a published page up
 * while quietly turning every customer away is worse than taking it down.
 * Neighbours would keep scanning a flyer that no longer works.
 *
 * Scheduled work is NOT cancelled. Those visits are already sold and
 * somebody is expecting them, so cancelling them would move money and break
 * promises the guardian may not have meant to break. The pause stops new
 * customers; what to do about outstanding visits is a separate decision,
 * and SAFETY_TRUST_POLICY section 2 says it belongs to the guardian and
 * support together, not to a single button.
 *
 * `db` must be the PRIVILEGED client: authorisation is checked here.
 */
export async function pauseBusinessAsGuardian(args: {
  db: Db
  businessId: string
  guardianUserId: string
  reasonCode?: string | null
  ip?: string | null
}): Promise<PauseResult> {
  const { db, businessId, guardianUserId } = args

  const { data: biz } = await db
    .from('businesses')
    .select('id, state, provider_user_id')
    .eq('id', businessId)
    .maybeSingle()

  if (!biz) return { ok: false, code: 'NOT_FOUND', message: 'No such business.' }

  const { data: rel } = await db
    .from('guardian_relationships')
    .select('id, state')
    .eq('provider_user_id', biz.provider_user_id)
    .eq('guardian_user_id', guardianUserId)
    .maybeSingle()

  // A guardian who is merely invited cannot pause. One who is verified can,
  // and one who has revoked already caused a pause.
  if (!rel || !['guardian_started', 'verified', 'manual_review'].includes(rel.state)) {
    return {
      ok: false,
      code: 'NOT_AUTHORIZED',
      message: 'This account cannot pause that business.',
    }
  }

  if (biz.state !== 'published') {
    return {
      ok: false,
      code: 'NOT_PAUSABLE',
      message: `A business that is ${biz.state} is already not taking customers.`,
    }
  }

  const { error } = await db
    .from('businesses')
    .update({ state: 'paused_guardian' })
    .eq('id', businessId)
    .eq('state', 'published')

  if (error) {
    console.error('[guardian] pause failed', error.message)
    return { ok: false, code: 'WRITE_FAILED', message: 'Could not pause that. Try again.' }
  }

  // Scoped to this business. The first draft counted every outstanding
  // occurrence on the platform, which would have told a guardian that
  // pausing one bin round affected several thousand visits.
  const { data: svcIds } = await db
    .from('provider_services')
    .select('id')
    .eq('business_id', businessId)

  let affected = 0
  if (svcIds?.length) {
    const { data: subIds } = await db
      .from('subscriptions')
      .select('id')
      .in('provider_service_id', svcIds.map((s) => s.id))

    if (subIds?.length) {
      const { count } = await db
        .from('service_occurrences')
        .select('id', { count: 'exact', head: true })
        .in('subscription_id', subIds.map((s) => s.id))
        .in('state', ['scheduled', 'due_today'])
      affected = count ?? 0
    }
  }

  await writeAudit({
    actorUserId: guardianUserId,
    actorRole: 'guardian',
    action: 'business.paused_guardian',
    targetType: 'business',
    targetId: businessId,
    before: { state: biz.state },
    after: { state: 'paused_guardian' },
    reasonCode: args.reasonCode ?? 'guardian_pause',
    ip: args.ip ?? null,
  })

  return { ok: true, state: 'paused_guardian', affectedOccurrences: affected }
}

/**
 * Puts it back.
 *
 * Only from paused_guardian: a business paused by an admin or suspended is
 * not a guardian's to restore, and letting a guardian lift a trust-and-
 * safety hold would make that hold advisory.
 */
export async function resumeBusinessAsGuardian(args: {
  db: Db
  businessId: string
  guardianUserId: string
  ip?: string | null
}): Promise<PauseResult> {
  const { db, businessId, guardianUserId } = args

  const { data: biz } = await db
    .from('businesses')
    .select('id, state, provider_user_id')
    .eq('id', businessId)
    .maybeSingle()

  if (!biz) return { ok: false, code: 'NOT_FOUND', message: 'No such business.' }

  const { data: rel } = await db
    .from('guardian_relationships')
    .select('id, state')
    .eq('provider_user_id', biz.provider_user_id)
    .eq('guardian_user_id', guardianUserId)
    .maybeSingle()

  // Resuming requires actual consent, not merely a started one.
  if (!rel || rel.state !== 'verified') {
    return {
      ok: false,
      code: 'NOT_AUTHORIZED',
      message: 'This account cannot resume that business.',
    }
  }

  if (biz.state !== 'paused_guardian') {
    return {
      ok: false,
      code: 'NOT_PAUSABLE',
      message: `A business that is ${biz.state} cannot be resumed by a guardian.`,
    }
  }

  const { error } = await db
    .from('businesses')
    .update({ state: 'published' })
    .eq('id', businessId)
    .eq('state', 'paused_guardian')

  if (error) {
    console.error('[guardian] resume failed', error.message)
    return { ok: false, code: 'WRITE_FAILED', message: 'Could not resume that. Try again.' }
  }

  await writeAudit({
    actorUserId: guardianUserId,
    actorRole: 'guardian',
    action: 'business.published',
    targetType: 'business',
    targetId: businessId,
    before: { state: 'paused_guardian' },
    after: { state: 'published' },
    reasonCode: 'guardian_resume',
    ip: args.ip ?? null,
  })

  return { ok: true, state: 'published', affectedOccurrences: 0 }
}
