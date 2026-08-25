/**
 * Stripe Connect onboarding.
 *
 * Creates the connected account for whoever is legally allowed to hold it
 * -- the provider if they are 18+, their guardian if they are 13-17 -- and
 * mirrors Stripe's view of that account back into the database.
 *
 * Stripe is the source of truth for whether an account can transact. The
 * columns on users are a cache, refreshed here and by webhook. Nothing in
 * this file decides that an account is ready; it only records what Stripe
 * says.
 *
 * All functions take the PRIVILEGED client. Clients hold no write grant on
 * users, so payout state cannot be moved from a browser.
 */

import { classifyAge, parsePlainDate } from '@/domain/age'
import { resolvePayoutHolder, payoutStage, type StripeAccountState } from '@/domain/payout'
import type { GuardianState } from '@/domain/guardian'
import { stripe } from '@/lib/stripe'
import { writeAudit } from '@/server/audit'
import { todayUtc } from '@/server/providerOnboarding'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'

type Db = SupabaseClient<Database>

export type PayoutFailureCode =
  | 'NO_PROVIDER_PROFILE'
  | 'PROVIDER_INELIGIBLE'
  | 'GUARDIAN_NOT_LINKED'
  | 'HOLDER_NOT_FOUND'
  | 'STRIPE_ERROR'
  | 'WRITE_FAILED'

export type EnsureAccountResult =
  | {
      ok: true
      holderUserId: string
      holder: 'self' | 'guardian'
      accountId: string
      created: boolean
    }
  | { ok: false; code: PayoutFailureCode }

/** Loads the provider, their age band, and the attached guardian if any. */
async function loadProviderContext(db: Db, providerUserId: string, now: Date) {
  const { data: profile } = await db
    .from('provider_profiles')
    .select('user_id, date_of_birth, guardian_state, payout_account_user_id')
    .eq('user_id', providerUserId)
    .maybeSingle()

  if (!profile) return null

  const { data: rel } = await db
    .from('guardian_relationships')
    .select('guardian_user_id, state')
    .eq('provider_user_id', providerUserId)
    .not('state', 'in', '(revoked,expired)')
    .maybeSingle()

  return {
    profile,
    band: classifyAge(parsePlainDate(profile.date_of_birth), todayUtc(now)),
    guardianUserId: rel?.guardian_user_id ?? null,
    guardianState: profile.guardian_state as GuardianState,
  }
}

/**
 * Creates the connected account if the holder does not already have one,
 * and points the provider at it.
 *
 * Idempotent: a holder who already has an account keeps it. One guardian
 * with two children on the platform therefore has one Stripe account and
 * completes identity verification once, which is both correct and the
 * humane outcome.
 */
export async function ensurePayoutAccount(args: {
  db: Db
  providerUserId: string
  now: Date
  ip?: string | null
}): Promise<EnsureAccountResult> {
  const { db, providerUserId, now } = args

  const ctx = await loadProviderContext(db, providerUserId, now)
  if (!ctx) return { ok: false, code: 'NO_PROVIDER_PROFILE' }

  const holder = resolvePayoutHolder({
    band: ctx.band,
    providerUserId,
    guardianUserId: ctx.guardianUserId,
    guardianState: ctx.guardianState,
  })
  if (!holder.ok) return { ok: false, code: holder.code }

  const { data: holderUser } = await db
    .from('users')
    .select('id, email, stripe_connected_account_id')
    .eq('id', holder.holderUserId)
    .maybeSingle()

  if (!holderUser) return { ok: false, code: 'HOLDER_NOT_FOUND' }

  let accountId = holderUser.stripe_connected_account_id
  let created = false

  if (!accountId) {
    try {
      // Accounts v2. Stripe no longer accepts v1 account creation for new
      // Connect integrations.
      const account = await stripe().v2.core.accounts.create({
        ...(holderUser.email ? { contact_email: holderUser.email } : {}),
        identity: { country: 'US', entity_type: 'individual' },
        // Express gives the holder a Stripe-hosted view of their payouts,
        // which is exactly what a guardian needs and saves us rebuilding it.
        dashboard: 'express',
        defaults: {
          currency: 'usd',
          responsibilities: {
            // The platform collects the customer fee and absorbs losses.
            // A parent who signed up so their kid could rake leaves should
            // not be carrying chargeback liability.
            fees_collector: 'application',
            losses_collector: 'application',
          },
        },
        // Recipient configuration with transfers only: the platform stays
        // merchant of record and the connected account never processes a
        // customer's card, so PCI scope stays here rather than with a
        // guardian.
        configuration: {
          recipient: {
            capabilities: { stripe_balance: { stripe_transfers: { requested: true } } },
          },
        },
        include: ['configuration.recipient', 'requirements'],
        metadata: {
          holder_user_id: holder.holderUserId,
          holds_for_provider_user_id: providerUserId,
          holder_kind: holder.holder,
        },
      })
      accountId = account.id
      created = true
    } catch (err) {
      console.error('[connect] account create failed', (err as Error).message)
      return { ok: false, code: 'STRIPE_ERROR' }
    }

    const { error } = await db
      .from('users')
      .update({ stripe_connected_account_id: accountId, stripe_synced_at: now.toISOString() })
      .eq('id', holder.holderUserId)
    if (error) {
      // The Stripe account exists but we failed to record it. Logged loudly
      // because the next attempt would otherwise create a second one.
      console.error('[connect] orphaned Stripe account', { accountId, error: error.message })
      return { ok: false, code: 'WRITE_FAILED' }
    }
  }

  if (ctx.profile.payout_account_user_id !== holder.holderUserId) {
    const { error } = await db
      .from('provider_profiles')
      .update({ payout_account_user_id: holder.holderUserId })
      .eq('user_id', providerUserId)
    if (error) {
      console.error('[connect] payout account link failed', error.message)
      return { ok: false, code: 'WRITE_FAILED' }
    }
  }

  if (created) {
    await writeAudit({
      actorUserId: providerUserId,
      actorRole: 'provider',
      action: 'payout.account_created',
      targetType: 'stripe_account',
      targetId: accountId,
      after: { holder: holder.holder, holder_user_id: holder.holderUserId },
      ip: args.ip ?? null,
    })
  }

  return { ok: true, holderUserId: holder.holderUserId, holder: holder.holder, accountId, created }
}

export type OnboardingLinkResult =
  | { ok: true; url: string; expiresAt: string; holder: 'self' | 'guardian' }
  | { ok: false; code: PayoutFailureCode }

/**
 * Returns a Stripe-hosted onboarding URL.
 *
 * Account Links are single-use and short-lived, so this is generated per
 * request and never stored. The URL is the credential -- anyone holding it
 * can complete identity onboarding for that account -- so it is returned
 * to the authenticated holder and never logged.
 */
export async function createOnboardingLink(args: {
  db: Db
  providerUserId: string
  returnUrl: string
  refreshUrl: string
  now: Date
  ip?: string | null
}): Promise<OnboardingLinkResult> {
  const ensured = await ensurePayoutAccount({
    db: args.db,
    providerUserId: args.providerUserId,
    now: args.now,
    ...(args.ip === undefined ? {} : { ip: args.ip }),
  })
  if (!ensured.ok) return { ok: false, code: ensured.code }

  try {
    const link = await stripe().v2.core.accountLinks.create({
      account: ensured.accountId,
      use_case: {
        type: 'account_onboarding',
        account_onboarding: {
          configurations: ['recipient'],
          refresh_url: args.refreshUrl,
          return_url: args.returnUrl,
        },
      },
    })

    await writeAudit({
      actorUserId: args.providerUserId,
      actorRole: 'provider',
      action: 'payout.onboarding_link_created',
      targetType: 'stripe_account',
      targetId: ensured.accountId,
      // The URL itself is deliberately not recorded.
      after: { holder: ensured.holder },
      ip: args.ip ?? null,
    })

    return { ok: true, url: link.url, expiresAt: link.expires_at, holder: ensured.holder }
  } catch (err) {
    console.error('[connect] account link failed', (err as Error).message)
    return { ok: false, code: 'STRIPE_ERROR' }
  }
}

export type SyncResult =
  | { ok: true; state: StripeAccountState; stage: ReturnType<typeof payoutStage> }
  | { ok: false; code: 'NOT_FOUND' | 'STRIPE_ERROR' | 'WRITE_FAILED' }

/**
 * Pulls the current account state from Stripe and mirrors it.
 *
 * Called after the provider returns from onboarding and from the webhook
 * handler. Writing what Stripe reports -- rather than assuming success
 * because the user came back from the hosted flow -- is the difference
 * between believing an account is ready and knowing it.
 */
export async function syncAccountState(args: {
  db: Db
  accountId: string
  now: Date
}): Promise<SyncResult> {
  const { db, accountId, now } = args

  let account
  try {
    account = await stripe().v2.core.accounts.retrieve(accountId, {
      include: ['configuration.recipient', 'requirements'],
    })
  } catch (err) {
    console.error('[connect] retrieve failed', (err as Error).message)
    return { ok: false, code: 'STRIPE_ERROR' }
  }

  const balance = account.configuration?.recipient?.capabilities?.stripe_balance

  // Only entries the USER can act on. Entries awaiting Stripe's own review
  // are not something a guardian can resolve, and surfacing them as
  // outstanding would make a submitted account look permanently unfinished.
  const requirementsDue = (account.requirements?.entries ?? [])
    .filter((e) => e.awaiting_action_from === 'user')
    .map((e) => e.description)
    .filter((d): d is string => typeof d === 'string')

  const state: StripeAccountState = {
    accountId: account.id,
    transfersActive: balance?.stripe_transfers?.status === 'active',
    payoutsActive: balance?.payouts?.status === 'active',
    requirementsDue,
  }

  const { data: updated, error } = await db
    .from('users')
    .update({
      stripe_transfers_active: state.transfersActive,
      stripe_payouts_active: state.payoutsActive,
      stripe_requirements_due: [...requirementsDue],
      stripe_synced_at: now.toISOString(),
    })
    .eq('stripe_connected_account_id', accountId)
    .select('id')
    .maybeSingle()

  if (error) {
    console.error('[connect] sync write failed', error.message)
    return { ok: false, code: 'WRITE_FAILED' }
  }
  if (!updated) return { ok: false, code: 'NOT_FOUND' }

  return { ok: true, state, stage: payoutStage(state) }
}
