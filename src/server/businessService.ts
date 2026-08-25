/**
 * Business and service builder (API_CONTRACT, Business / service).
 *
 * The catalog governs what a service IS. A provider chooses from it and may
 * set only price, schedule, capacity, area and approved wording -- so every
 * write here validates against the catalog row rather than trusting the
 * request. CLAUDE.md rule 3.
 *
 * All functions take the PRIVILEGED client. No client holds a write grant on
 * businesses or provider_services, deliberately: a direct insert would let a
 * caller pick their own catalog_service_id, price, or published state.
 */

import { z } from 'zod'
import { classifyAge, ageInYearsOn, parsePlainDate } from '@/domain/age'
import { canOfferService, flagProhibitedWording, type CatalogService } from '@/domain/catalog'
import { checkSlug, uniqueSlug } from '@/domain/slug'
import { publishBlockers, type ServiceReadiness, type PublishBlocker } from '@/domain/publish'
import type { GuardianState } from '@/domain/guardian'
import { NO_ACCOUNT, type StripeAccountState } from '@/domain/payout'
import { writeAudit } from '@/server/audit'
import { todayUtc } from '@/server/providerOnboarding'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'

type Db = SupabaseClient<Database>

export const createBusinessSchema = z.object({
  name: z.string().trim().min(2).max(60),
  tagline: z.string().trim().max(120).optional(),
  about: z.string().trim().max(2000).optional(),
  publicAreaLabel: z.string().trim().max(80).optional(),
  /** Optional preferred slug; derived from the name when absent. */
  slug: z.string().trim().max(40).optional(),
})
export type CreateBusinessInput = z.infer<typeof createBusinessSchema>

export const addServiceSchema = z.object({
  catalogCode: z.string().trim().min(1).max(64),
  publicName: z.string().trim().min(2).max(80),
  description: z.string().trim().min(10).max(1200),
  priceCents: z.number().int().positive().max(100_000),
  priceUnit: z.enum(['week', 'visit', 'month']),
  billingCycleWeeks: z.union([z.literal(1), z.literal(2), z.literal(4)]).default(4),
  scheduleRule: z.record(z.string(), z.unknown()),
  capacityRule: z.record(z.string(), z.unknown()),
  providerLimits: z.record(z.string(), z.unknown()).default({}),
})
export type AddServiceInput = z.infer<typeof addServiceSchema>

export type ProviderContext = {
  providerUserId: string
  band: ReturnType<typeof classifyAge>
  ageInYears: number
  guardianState: GuardianState
  guardianApprovedCodes: string[]
  account: StripeAccountState
}

/** Loads everything the catalog and publish rules need about a provider. */
async function loadProvider(db: Db, providerUserId: string, now: Date): Promise<ProviderContext | null> {
  const { data: profile } = await db
    .from('provider_profiles')
    .select('user_id, date_of_birth, guardian_state, payout_account_user_id')
    .eq('user_id', providerUserId)
    .maybeSingle()
  if (!profile) return null

  const dob = parsePlainDate(profile.date_of_birth)
  const today = todayUtc(now)

  const { data: rel } = await db
    .from('guardian_relationships')
    .select('id')
    .eq('provider_user_id', providerUserId)
    .not('state', 'in', '(revoked,expired)')
    .maybeSingle()

  let guardianApprovedCodes: string[] = []
  if (rel) {
    const { data: approvals } = await db
      .from('guardian_service_approvals')
      .select('catalog_code')
      .eq('relationship_id', rel.id)
      .is('revoked_at', null)
    guardianApprovedCodes = (approvals ?? []).map((a) => a.catalog_code)
  }

  let account = NO_ACCOUNT
  if (profile.payout_account_user_id) {
    const { data: holder } = await db
      .from('users')
      .select(
        'stripe_connected_account_id, stripe_transfers_active, stripe_payouts_active, stripe_requirements_due',
      )
      .eq('id', profile.payout_account_user_id)
      .maybeSingle()
    if (holder) {
      account = {
        accountId: holder.stripe_connected_account_id,
        transfersActive: holder.stripe_transfers_active,
        payoutsActive: holder.stripe_payouts_active,
        requirementsDue: (holder.stripe_requirements_due ?? []) as string[],
      }
    }
  }

  return {
    providerUserId,
    band: classifyAge(dob, today),
    ageInYears: ageInYearsOn(dob, today),
    guardianState: profile.guardian_state as GuardianState,
    guardianApprovedCodes,
    account,
  }
}

export type CreateBusinessResult =
  | { ok: true; businessId: string; slug: string }
  | {
      ok: false
      code: 'NO_PROVIDER_PROFILE' | 'PROVIDER_INELIGIBLE' | 'SLUG_UNAVAILABLE' | 'ALREADY_HAS_LIVE_BUSINESS' | 'WRITE_FAILED'
    }

/**
 * Creates a draft business.
 *
 * Drafting is deliberately open to any eligible provider, guardian-verified
 * or not -- SAFETY_TRUST_POLICY section 2 allows a minor to build their page
 * while consent is pending. Only publishing is gated.
 */
export async function createBusiness(args: {
  db: Db
  providerUserId: string
  input: CreateBusinessInput
  now: Date
  ip?: string | null
}): Promise<CreateBusinessResult> {
  const { db, providerUserId, input, now } = args

  const ctx = await loadProvider(db, providerUserId, now)
  if (!ctx) return { ok: false, code: 'NO_PROVIDER_PROFILE' }
  if (ctx.band === 'under_min_age') return { ok: false, code: 'PROVIDER_INELIGIBLE' }

  // A requested slug is checked as given; a derived one is made unique.
  let slug: string
  if (input.slug) {
    const check = checkSlug(input.slug)
    if (!check.ok) return { ok: false, code: 'SLUG_UNAVAILABLE' }
    slug = input.slug
  } else {
    const { data: existing } = await db.from('businesses').select('slug')
    slug = uniqueSlug(input.name, new Set((existing ?? []).map((b) => b.slug)))
  }

  const { data: row, error } = await db
    .from('businesses')
    .insert({
      provider_user_id: providerUserId,
      name: input.name,
      slug,
      tagline: input.tagline ?? null,
      about: input.about ?? null,
      public_area_label: input.publicAreaLabel ?? null,
      state: 'draft',
    })
    .select('id, slug')
    .single()

  if (error || !row) {
    if (error?.code === '23505') return { ok: false, code: 'SLUG_UNAVAILABLE' }
    console.error('[business] create failed', error?.message)
    return { ok: false, code: 'WRITE_FAILED' }
  }

  await writeAudit({
    actorUserId: providerUserId,
    actorRole: 'provider',
    action: 'business.created',
    targetType: 'business',
    targetId: row.id,
    after: { slug: row.slug, state: 'draft' },
    ip: args.ip ?? null,
  })

  return { ok: true, businessId: row.id, slug: row.slug }
}

export type AddServiceResult =
  | { ok: true; serviceId: string; slug: string; flagged: boolean }
  | {
      ok: false
      code:
        | 'NO_PROVIDER_PROFILE'
        | 'BUSINESS_NOT_FOUND'
        | 'UNKNOWN_CATALOG_SERVICE'
        | 'SERVICE_NOT_AVAILABLE'
        | 'PROVIDER_TOO_YOUNG'
        | 'ADULT_ONLY_CATEGORY'
        | 'GUARDIAN_APPROVAL_REQUIRED'
        | 'CATEGORY_NOT_APPROVED_BY_GUARDIAN'
        | 'PROHIBITED_WORDING'
        | 'WRITE_FAILED'
      flags?: readonly { reason: string; match: string }[]
    }

/**
 * Adds a service to a business, from the catalog.
 *
 * The provider supplies a description; the catalog supplies the risk tier,
 * minimum age and guardian requirement. Free text that describes work
 * outside every launch category is refused rather than quietly stored --
 * SAFETY_TRUST_POLICY section 5.
 */
export async function addService(args: {
  db: Db
  providerUserId: string
  businessId: string
  input: AddServiceInput
  now: Date
  ip?: string | null
}): Promise<AddServiceResult> {
  const { db, providerUserId, businessId, input, now } = args

  const ctx = await loadProvider(db, providerUserId, now)
  if (!ctx) return { ok: false, code: 'NO_PROVIDER_PROFILE' }

  const { data: business } = await db
    .from('businesses')
    .select('id, provider_user_id')
    .eq('id', businessId)
    .eq('provider_user_id', providerUserId)
    .maybeSingle()
  if (!business) return { ok: false, code: 'BUSINESS_NOT_FOUND' }

  const { data: catalogRow } = await db
    .from('service_catalog')
    .select('id, code, name, risk_tier, min_provider_age, guardian_explicit_approval, active')
    .eq('code', input.catalogCode)
    .maybeSingle()
  if (!catalogRow) return { ok: false, code: 'UNKNOWN_CATALOG_SERVICE' }

  const service: CatalogService = {
    id: catalogRow.id,
    code: catalogRow.code,
    name: catalogRow.name,
    riskTier: catalogRow.risk_tier,
    minProviderAge: catalogRow.min_provider_age,
    guardianExplicitApproval: catalogRow.guardian_explicit_approval,
    active: catalogRow.active,
  }

  const eligible = canOfferService({
    service,
    ageInYears: ctx.ageInYears,
    band: ctx.band,
    guardianState: ctx.guardianState,
    guardianApprovedCodes: ctx.guardianApprovedCodes,
  })
  if (!eligible.allowed) return { ok: false, code: eligible.code }

  // Scope check on everything the provider wrote, not just the description:
  // a public name is equally capable of advertising prohibited work.
  const flags = flagProhibitedWording(`${input.publicName} ${input.description}`)
  if (flags.length > 0) {
    await writeAudit({
      actorUserId: providerUserId,
      actorRole: 'provider',
      action: 'service.wording_refused',
      targetType: 'business',
      targetId: businessId,
      after: { catalog_code: service.code, reasons: flags.map((f) => f.reason) },
      ip: args.ip ?? null,
    })
    return { ok: false, code: 'PROHIBITED_WORDING', flags }
  }

  const { data: siblings } = await db
    .from('provider_services')
    .select('slug')
    .eq('business_id', businessId)
  const slug = uniqueSlug(input.publicName, new Set((siblings ?? []).map((s) => s.slug)))

  const { data: row, error } = await db
    .from('provider_services')
    .insert({
      business_id: businessId,
      catalog_service_id: service.id,
      slug,
      public_name: input.publicName,
      description: input.description,
      price_cents: input.priceCents,
      price_unit: input.priceUnit,
      billing_cycle_weeks: input.billingCycleWeeks,
      schedule_rule: input.scheduleRule,
      capacity_rule: input.capacityRule,
      provider_limits: input.providerLimits,
      state: 'draft',
    })
    .select('id, slug')
    .single()

  if (error || !row) {
    console.error('[business] add service failed', error?.message)
    return { ok: false, code: 'WRITE_FAILED' }
  }

  await writeAudit({
    actorUserId: providerUserId,
    actorRole: 'provider',
    action: 'service.created',
    targetType: 'provider_service',
    targetId: row.id,
    after: { catalog_code: service.code, price_cents: input.priceCents, slug: row.slug },
    ip: args.ip ?? null,
  })

  return { ok: true, serviceId: row.id, slug: row.slug, flagged: false }
}

export type PublishResult =
  | { ok: true; slug: string; publishedAt: string }
  | { ok: false; code: 'NO_PROVIDER_PROFILE' | 'BUSINESS_NOT_FOUND' | 'BLOCKED' | 'WRITE_FAILED'; blockers?: readonly PublishBlocker[] }

/**
 * Publishes a business.
 *
 * Re-evaluates every condition at publish time rather than trusting a flag
 * set earlier. A guardian may have revoked consent, or Stripe may have
 * restricted the account, since the provider last looked at the page.
 */
export async function publishBusiness(args: {
  db: Db
  providerUserId: string
  businessId: string
  now: Date
  ip?: string | null
}): Promise<PublishResult> {
  const { db, providerUserId, businessId, now } = args

  const ctx = await loadProvider(db, providerUserId, now)
  if (!ctx) return { ok: false, code: 'NO_PROVIDER_PROFILE' }

  const { data: business } = await db
    .from('businesses')
    .select('id, slug, state, public_area_label')
    .eq('id', businessId)
    .eq('provider_user_id', providerUserId)
    .maybeSingle()
  if (!business) return { ok: false, code: 'BUSINESS_NOT_FOUND' }

  const { data: services } = await db
    .from('provider_services')
    .select('id, state, schedule_rule, price_cents')
    .eq('business_id', businessId)

  const serviceIds = (services ?? []).map((s) => s.id)
  const { data: areas } = serviceIds.length
    ? await db.from('service_areas').select('provider_service_id').in('provider_service_id', serviceIds)
    : { data: [] as { provider_service_id: string }[] }
  const withArea = new Set((areas ?? []).map((a) => a.provider_service_id))

  const readiness: ServiceReadiness[] = (services ?? []).map((s) => ({
    id: s.id,
    state: s.state,
    hasServiceArea: withArea.has(s.id),
    hasSchedule: Object.keys(s.schedule_rule ?? {}).length > 0,
    priceCents: s.price_cents,
  }))

  const blockers = publishBlockers({
    band: ctx.band,
    guardianState: ctx.guardianState,
    account: ctx.account,
    businessState: business.state,
    publicAreaLabel: business.public_area_label,
    services: readiness,
  })

  if (blockers.length > 0) return { ok: false, code: 'BLOCKED', blockers }

  const publishedAt = now.toISOString()
  const { error } = await db
    .from('businesses')
    .update({ state: 'published', published_at: publishedAt })
    .eq('id', businessId)

  if (error) {
    console.error('[business] publish failed', error.message)
    return { ok: false, code: 'WRITE_FAILED' }
  }

  await writeAudit({
    actorUserId: providerUserId,
    actorRole: 'provider',
    action: 'business.published',
    targetType: 'business',
    targetId: businessId,
    before: { state: business.state },
    after: { state: 'published', slug: business.slug },
    ip: args.ip ?? null,
  })

  return { ok: true, slug: business.slug, publishedAt }
}

export const serviceAreaSchema = z.object({
  /** GeoJSON polygon used for address eligibility. Never public. */
  privateGeometry: z.record(z.string(), z.unknown()),
  /** Coarse shape safe to publish. Optional; without it the map stays hidden. */
  publicGeneralizedGeometry: z.record(z.string(), z.unknown()).optional(),
  label: z.string().trim().max(80).optional(),
})
export type ServiceAreaInput = z.infer<typeof serviceAreaSchema>

export type SetServiceAreaResult =
  | { ok: true; serviceAreaId: string }
  | { ok: false; code: 'SERVICE_NOT_FOUND' | 'WRITE_FAILED' }

/**
 * Stores the service area for one provider service.
 *
 * Ownership is checked by joining back to the business rather than trusting
 * the id in the path -- a service id is guessable in a way a session is not.
 *
 * The private geometry is what address eligibility is computed against and
 * is never returned to an unauthenticated caller. SAFETY_TRUST_POLICY
 * section 3: for a minor, the shape of the area they serve is itself a
 * location hint.
 */
export async function setServiceArea(args: {
  db: Db
  providerUserId: string
  providerServiceId: string
  input: ServiceAreaInput
  now: Date
  ip?: string | null
}): Promise<SetServiceAreaResult> {
  const { db, providerUserId, providerServiceId, input } = args

  const { data: owned } = await db
    .from('provider_services')
    .select('id, business_id, businesses!inner(provider_user_id)')
    .eq('id', providerServiceId)
    .eq('businesses.provider_user_id', providerUserId)
    .maybeSingle()

  if (!owned) return { ok: false, code: 'SERVICE_NOT_FOUND' }

  const { data: row, error } = await db
    .from('service_areas')
    .upsert(
      {
        provider_service_id: providerServiceId,
        private_geometry: input.privateGeometry,
        public_generalized_geometry: input.publicGeneralizedGeometry ?? null,
        label: input.label ?? null,
      },
      { onConflict: 'provider_service_id' },
    )
    .select('id')
    .single()

  if (error || !row) {
    console.error('[business] service area write failed', error?.message)
    return { ok: false, code: 'WRITE_FAILED' }
  }

  await writeAudit({
    actorUserId: providerUserId,
    actorRole: 'provider',
    action: 'service.area_set',
    targetType: 'provider_service',
    targetId: providerServiceId,
    // The geometry itself is not recorded: an audit row should not become a
    // second copy of a minor's service boundary.
    after: { has_public_shape: input.publicGeneralizedGeometry !== undefined },
    ip: args.ip ?? null,
  })

  return { ok: true, serviceAreaId: row.id }
}
