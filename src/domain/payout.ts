/**
 * Payout accounts.
 *
 * Stripe requires a connected account holder to be an adult. That is a
 * processor constraint, not a product preference, so the domain models it
 * directly: an account belongs to whoever is legally allowed to hold it,
 * and a provider points at that holder.
 *
 *   provider aged 18+   holds their own account
 *   provider aged 13-17 uses their guardian's account
 *
 * The minor still owns the business and still keeps their listed price --
 * the internal ledger credits earnings per provider. Only the destination
 * of the payout differs. PRD section 12: "Set your price. Keep your price."
 */

import type { AgeBand } from './age'
import { isGuardianCleared, type GuardianState } from './guardian'

/**
 * Mirrored from Stripe. Never assumed, never written by a client.
 *
 * Named for what Stripe Accounts v2 actually reports. There is deliberately
 * no `chargesEnabled`: under the Marketplace model the platform is merchant
 * of record and the connected account never processes a card, so whether it
 * *could* is not a question worth storing an answer to.
 */
export type StripeAccountState = {
  accountId: string | null
  /** stripe_balance.stripe_transfers.status === 'active' -- money can arrive. */
  transfersActive: boolean
  /** stripe_balance.payouts.status === 'active' -- money can reach a bank. */
  payoutsActive: boolean
  /**
   * requirements.entries awaiting action from the USER, as field paths.
   *
   * Informational only -- it drives what the guardian is asked to go and
   * complete. It deliberately does NOT gate readiness: Stripe keeps a
   * capability active while future-dated requirements are outstanding, so
   * gating here would strand accounts that Stripe considers fine.
   */
  requirementsDue: readonly string[]
}

export const NO_ACCOUNT: StripeAccountState = {
  accountId: null,
  transfersActive: false,
  payoutsActive: false,
  requirementsDue: [],
}

export type PayoutHolder = 'self' | 'guardian'

export type HolderResolution =
  | { ok: true; holder: PayoutHolder; holderUserId: string }
  | { ok: false; code: 'PROVIDER_INELIGIBLE' | 'GUARDIAN_NOT_LINKED' }

/**
 * Decides whose connected account a provider's money should land in.
 *
 * A minor cannot proceed until a guardian is actually attached -- not
 * merely invited. An invitation that nobody has opened is not a person
 * Stripe can verify, so `required_uninvited`, `invited`, `revoked` and
 * `expired` all resolve to GUARDIAN_NOT_LINKED rather than silently
 * falling back to the minor holding their own account.
 */
export function resolvePayoutHolder(args: {
  band: AgeBand
  providerUserId: string
  guardianUserId: string | null
  guardianState: GuardianState
}): HolderResolution {
  if (args.band === 'under_min_age') return { ok: false, code: 'PROVIDER_INELIGIBLE' }

  if (args.band === 'adult') {
    return { ok: true, holder: 'self', holderUserId: args.providerUserId }
  }

  // Minor. A guardian must be attached and at least mid-flow.
  const attached =
    args.guardianUserId !== null &&
    (args.guardianState === 'guardian_started' || args.guardianState === 'verified')

  if (!attached) return { ok: false, code: 'GUARDIAN_NOT_LINKED' }

  return { ok: true, holder: 'guardian', holderUserId: args.guardianUserId! }
}

export type PayoutStage = 'not_started' | 'requirements_due' | 'ready'

export function payoutStage(state: StripeAccountState): PayoutStage {
  if (state.accountId === null) return 'not_started'
  // Stripe's capability status is the authoritative answer to "can money
  // move". It goes restricted the moment a requirement actually blocks it.
  if (state.transfersActive && state.payoutsActive) return 'ready'
  return 'requirements_due'
}

/**
 * Can this provider actually be paid?
 *
 * Deliberately requires BOTH transfers and payouts. An account that can
 * receive transfers but cannot pay out would let money accumulate against a
 * provider who can never actually get it, which is a worse failure than
 * refusing the work up front.
 */
export function isPayoutReady(state: StripeAccountState): boolean {
  return payoutStage(state) === 'ready'
}

export type PayoutGateDenial =
  | 'PROVIDER_INELIGIBLE'
  | 'GUARDIAN_NOT_LINKED'
  | 'GUARDIAN_APPROVAL_REQUIRED'
  | 'PAYOUT_ONBOARDING_INCOMPLETE'

export type PayoutGate = { allowed: true } | { allowed: false; code: PayoutGateDenial }

/**
 * The full check before a provider may take money.
 *
 * Guardian clearance and payout readiness are separate requirements and
 * both must hold. A verified guardian who has not finished Stripe's
 * identity requirements cannot receive money, and a fully onboarded Stripe
 * account does not substitute for guardian consent.
 */
export function canReceivePayments(args: {
  band: AgeBand
  providerUserId: string
  guardianUserId: string | null
  guardianState: GuardianState
  account: StripeAccountState
}): PayoutGate {
  const holder = resolvePayoutHolder(args)
  if (!holder.ok) return { allowed: false, code: holder.code }

  if (!isGuardianCleared(args.guardianState)) {
    return { allowed: false, code: 'GUARDIAN_APPROVAL_REQUIRED' }
  }

  if (!isPayoutReady(args.account)) {
    return { allowed: false, code: 'PAYOUT_ONBOARDING_INCOMPLETE' }
  }

  return { allowed: true }
}
