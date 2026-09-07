/**
 * Strikes, suspensions and bans.
 *
 * Lifted out of disputeService, which held two unrelated things: refunds
 * and account standing. Refunds went with the payment system; this did not.
 * The name was always slightly wrong -- a "dispute" there meant a card
 * chargeback, and none of the code below is about money.
 *
 * PRD section 24: every staff action needs a permission and a recorded
 * reason. The reason is checked before the state changes, so an account
 * suspended without one is not a suspension with a missing note -- it is
 * an account that is still active.
 */

import {
  accountStanding,
  checkAccountAction,
  isAccountActionKind,
  type AccountActionKind,
  type AccountStanding,
} from '@/domain/enforcement'
import { checkReason } from '@/domain/incident'
import type { AdminActor } from '@/server/adminService'
import { roleGranting } from '@/domain/roles'
import { writeAudit, type AuditAction } from '@/server/audit'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'

const AUDIT_ACTION_FOR: Readonly<Record<AccountActionKind, AuditAction>> = {
  strike: 'account.struck',
  suspend: 'account.suspended',
  ban: 'account.banned',
  reinstate: 'account.reinstated',
}

type Db = SupabaseClient<Database>

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
    // Named for what actually happened. Every kind used to write
    // 'account.suspended', so a reinstatement was logged as a suspension
    // and "show me every ban" returned nothing -- the kind was only in the
    // snapshot, and the action field is what anybody filters on.
    action: AUDIT_ACTION_FOR[kind],
    targetType: 'user',
    targetId: args.subjectUserId,
    before: { status: before.status, strikes: before.strikes },
    after: { status: after.status, strikes: after.strikes, kind },
    reasonCode: reason.reason,
    ip: args.actor.ip ?? null,
  })

  return { ok: true, standing: after }
}
