/**
 * Disputes: refund the wronged neighbour, remove the jerk.
 *
 * The owner's legal pass makes both halves explicit, and they are
 * deliberately separate. Money goes back because somebody did not get what
 * they paid for. An account consequence follows because of what somebody
 * DID. Tying them together would mean a refund implies wrongdoing, and most
 * refunds are a missed bin on a bad week.
 *
 * ## Why refunds are fast on purpose
 *
 * A customer who cannot get $3 back from us gets it back from their bank
 * instead. That costs about $15 in chargeback fees, damages the platform's
 * standing with Stripe, and the money still leaves -- so a slow refund
 * process is more expensive than a generous one. Below the reason
 * threshold this asks for no justification at all, because demanding an
 * essay for a $3 credit trains staff to type filler.
 *
 * ## No monetary penalties, ever
 *
 * There is no code path here that charges anybody a fee for behaving
 * badly, and there should not be one. The provider is frequently a
 * fourteen-year-old whose payout account we hold; fining them over a
 * missed collection is taking money from a child. Removing them costs them
 * the work, which is proportionate and needs nobody to price a teenager's
 * bad week.
 */

import {
  accountStanding,
  checkAccountAction,
  isAccountActionKind,
  type AccountActionKind,
  type AccountStanding,
} from '@/domain/enforcement'
import { checkReason } from '@/domain/incident'
import { checkRefundAuthorization, type AdminActor } from '@/server/adminService'
import { roleGranting } from '@/domain/roles'
import { writeStandaloneEntries } from '@/server/ledgerWriter'
import { getCharger } from '@/server/charger'
import { writeAudit } from '@/server/audit'
import type { LedgerEntry } from '@/domain/ledger'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'

type Db = SupabaseClient<Database>

export type RefundResult =
  | { ok: true; refundedCents: number; externalId: string | null }
  | {
      ok: false
      code:
        | 'NOT_AUTHORIZED'
        | 'REASON_REQUIRED'
        | 'NOT_FOUND'
        | 'NOTHING_TO_REFUND'
        | 'TOO_MUCH'
        | 'PROCESSOR_FAILED'
        | 'WRITE_FAILED'
      message: string
    }

/**
 * Hands money back on a subscription.
 *
 * Refunds against the original charge, so it lands on the card the customer
 * actually paid with. Never more than was charged and not already refunded
 * -- the cap is computed from the ledger rather than trusted from the
 * request, because a typo in an amount field should not be able to send
 * more money than came in.
 *
 * The processor moves first, then the ledger. Same reasoning as settlement:
 * money moved with no row is visible and repairable from Stripe's records,
 * while a row claiming a refund that never happened balances the books
 * against a payment the customer never received.
 */
export async function issueRefund(args: {
  db: Db
  actor: AdminActor
  subscriptionId: string
  amountCents: number
  reason: unknown
  incidentId?: string | undefined
}): Promise<RefundResult> {
  const authorized = checkRefundAuthorization({
    actor: args.actor,
    amountCents: args.amountCents,
    reason: args.reason,
  })
  if (!authorized.ok) return { ok: false, code: authorized.code as never, message: authorized.message }

  if (!Number.isInteger(args.amountCents) || args.amountCents <= 0) {
    return { ok: false, code: 'NOTHING_TO_REFUND', message: 'Enter an amount to refund.' }
  }

  const { data: sub } = await args.db
    .from('subscriptions')
    .select('id, customer_user_id, provider_service_id')
    .eq('id', args.subscriptionId)
    .maybeSingle()

  if (!sub) return { ok: false, code: 'NOT_FOUND', message: 'No such subscription.' }

  const { data: entries } = await args.db
    .from('ledger_entries')
    .select('kind, amount_cents, external_id')
    .eq('subscription_id', args.subscriptionId)

  const rows = entries ?? []
  const charged = rows
    .filter((e) => e.kind === 'customer_charge')
    .reduce((a, e) => a + e.amount_cents, 0)
  // Refunds are negative in the platform's sign convention.
  const alreadyRefunded = -rows
    .filter((e) => e.kind === 'refund')
    .reduce((a, e) => a + e.amount_cents, 0)

  const refundable = charged - alreadyRefunded
  if (refundable <= 0) {
    return { ok: false, code: 'NOTHING_TO_REFUND', message: 'Nothing left to refund here.' }
  }
  if (args.amountCents > refundable) {
    return {
      ok: false,
      code: 'TOO_MUCH',
      message: `The most that can be refunded on this subscription is ${(refundable / 100).toFixed(2)}.`,
    }
  }

  const originalCharge = rows.find((e) => e.kind === 'customer_charge' && e.external_id)
  const idempotencyKey = `refund:${args.subscriptionId}:${charged}:${alreadyRefunded + args.amountCents}`

  let externalId: string | null = null
  if (originalCharge?.external_id) {
    const refunded = await getCharger().refund({
      amountCents: args.amountCents,
      externalChargeId: originalCharge.external_id,
      idempotencyKey,
      reason: 'dispute',
    })
    if (!refunded.ok) {
      return { ok: false, code: 'PROCESSOR_FAILED', message: refunded.message }
    }
    externalId = refunded.externalId
  }

  // Balanced pair, the same shape cancellation uses: the platform gives up
  // what it holds, and the customer is handed it back.
  const ledger: LedgerEntry[] = [
    {
      kind: 'adjustment',
      amountCents: args.amountCents,
      currency: 'USD',
      subscriptionId: args.subscriptionId,
      customerUserId: sub.customer_user_id,
      memo: 'Dispute resolved in the customer’s favour',
    },
    {
      kind: 'refund',
      amountCents: -args.amountCents,
      currency: 'USD',
      subscriptionId: args.subscriptionId,
      customerUserId: sub.customer_user_id,
      idempotencyKey,
      ...(externalId ? { externalProcessor: 'stripe', externalId } : {}),
      memo: 'Refunded to the customer',
    },
  ]

  const written = await writeStandaloneEntries({ db: args.db, entries: ledger })
  if (!written.ok) {
    console.error('[dispute] ledger write failed after refund', {
      subscriptionId: args.subscriptionId,
      externalId,
    })
    return { ok: false, code: 'WRITE_FAILED', message: written.message }
  }

  await writeAudit({
    actorUserId: args.actor.userId,
    actorRole: roleGranting(args.actor.roles, 'refund:issue'),
    action: 'refund.issued',
    targetType: 'subscription',
    targetId: args.subscriptionId,
    after: {
      amount_cents: args.amountCents,
      external_id: externalId,
      ...(args.incidentId ? { incident_id: args.incidentId } : {}),
    },
    // Null below the threshold, by design -- see checkRefundAuthorization.
    reasonCode: authorized.reason ?? 'goodwill',
    ip: args.actor.ip ?? null,
  })

  return { ok: true, refundedCents: args.amountCents, externalId }
}

export type AccountActionResult =
  | { ok: true; standing: AccountStanding }
  | {
      ok: false
      code: 'NOT_AUTHORIZED' | 'REASON_REQUIRED' | 'INVALID' | 'NOT_ALLOWED' | 'WRITE_FAILED'
      message: string
    }

export async function readStanding(args: { db: Db; userId: string }): Promise<AccountStanding> {
  const { data } = await args.db
    .from('account_actions')
    .select('kind, created_at')
    .eq('subject_user_id', args.userId)

  return accountStanding((data ?? []).map((a) => ({ kind: a.kind, createdAt: a.created_at })))
}

/**
 * Records a consequence, and keeps users.status in step with it.
 *
 * The status column is what guard() checks on every permissioned action.
 * Writing the history without updating it would leave a suspended account
 * able to do everything -- which is exactly the state this codebase was in
 * before this migration.
 */
export async function applyAccountAction(args: {
  db: Db
  actor: AdminActor
  subjectUserId: string
  kind: unknown
  reason: unknown
  incidentId?: string | undefined
}): Promise<AccountActionResult> {
  if (!isAccountActionKind(args.kind)) {
    return { ok: false, code: 'INVALID', message: 'Unknown action.' }
  }
  const kind: AccountActionKind = args.kind

  const permission = kind === 'strike' ? 'moderation:act' : 'account:suspend'
  const role = roleGranting(args.actor.roles, permission)
  if (!role) {
    return { ok: false, code: 'NOT_AUTHORIZED', message: 'This account cannot do that.' }
  }

  if (args.actor.userId === args.subjectUserId) {
    return { ok: false, code: 'NOT_ALLOWED', message: 'You cannot action your own account.' }
  }

  const reason = checkReason(args.reason, `account.${kind}`)
  if (!reason.ok) return { ok: false, code: 'REASON_REQUIRED', message: reason.message }

  const before = await readStanding({ db: args.db, userId: args.subjectUserId })
  const allowed = checkAccountAction(before, kind)
  if (!allowed.ok) return { ok: false, code: 'NOT_ALLOWED', message: allowed.message }

  const { error } = await args.db.from('account_actions').insert({
    subject_user_id: args.subjectUserId,
    kind,
    reason: reason.reason,
    actor_user_id: args.actor.userId,
    actor_role: role,
    ...(args.incidentId ? { incident_id: args.incidentId } : {}),
  })

  if (error) {
    console.error('[dispute] account action write failed', error.message)
    return { ok: false, code: 'WRITE_FAILED', message: 'That did not save. Please try again.' }
  }

  const after = await readStanding({ db: args.db, userId: args.subjectUserId })

  const { error: statusError } = await args.db
    .from('users')
    .update({ status: after.status })
    .eq('id', args.subjectUserId)

  if (statusError) {
    // The history is written and the status is not, so the account is
    // still acting. Loud: this is the half that actually stops anything.
    console.error('[dispute] status update failed after account action', {
      subjectUserId: args.subjectUserId,
      intended: after.status,
      message: statusError.message,
    })
  }

  await writeAudit({
    actorUserId: args.actor.userId,
    actorRole: role,
    action: 'account.suspended',
    targetType: 'user',
    targetId: args.subjectUserId,
    before: { status: before.status, strikes: before.strikes },
    after: { status: after.status, strikes: after.strikes, kind },
    reasonCode: reason.reason,
    ip: args.actor.ip ?? null,
  })

  return { ok: true, standing: after }
}
