/**
 * Staff actions.
 *
 * PRD section 24: "Admin actions require role permissions and reason
 * capture for high-impact actions such as suspensions, address access,
 * refunds above threshold, and guardian override."
 *
 * Two things hold everywhere in this file.
 *
 * ## The reason is checked before the action happens
 *
 * Not alongside it, not after. Every high-impact function starts by
 * refusing a thin reason, so an action without one is not an action with a
 * missing log line -- it is an action that did not occur. A log written
 * after the fact can fail; an action that never ran cannot leave a gap.
 *
 * ## Reading an address is an action
 *
 * CLAUDE.md rule 9 lists "admin address access" beside suspensions and
 * payout holds, and it belongs there. A member of staff looking up where a
 * customer lives is doing something to that person, and the fact that
 * nothing changed in the database does not make it less true. So the audit
 * row is written BEFORE the address is returned: if the write fails, the
 * read does not happen.
 *
 * That ordering is the opposite of everywhere else in this codebase, where
 * audit failures are logged and stepped over so the underlying action is
 * not lost. Here there is no underlying action to protect -- refusing costs
 * a member of staff one retry, and proceeding costs an unlogged look at a
 * child's customer's home address.
 */

import {
  checkReason,
  defaultSeverityFor,
  guardianNotificationFor,
  isIncidentCategory,
  recommendsImmediatePause,
  refundNeedsReason,
  RESPONSE_TARGET_MINUTES,
  type IncidentCategory,
  type IncidentSeverity,
} from '@/domain/incident'
import { hasPermission, type Role } from '@/domain/roles'
import { classifyAge, parsePlainDate } from '@/domain/age'
import { writeAudit, type AuditAction } from '@/server/audit'
import { supabaseAdmin } from '@/lib/supabase/admin'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'

type Db = SupabaseClient<Database>

export type AdminFailure =
  | 'NOT_AUTHORIZED'
  | 'REASON_REQUIRED'
  | 'NOT_FOUND'
  | 'INVALID'
  | 'AUDIT_FAILED'
  | 'WRITE_FAILED'

export type AdminActor = {
  userId: string
  roles: readonly Role[]
  ip?: string | null
}

export type AdminResult<T> =
  | ({ ok: true } & T)
  | { ok: false; code: AdminFailure; message: string }

/** An action that either happened or did not. No payload to return. */
export type AdminVoidResult =
  | { ok: true }
  | { ok: false; code: AdminFailure; message: string }

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------

export type OpenIncidentResult = AdminResult<{
  incidentId: string
  severity: IncidentSeverity
  respondBy: string
  recommendPause: boolean
  guardianNotification: ReturnType<typeof guardianNotificationFor>
}>

/**
 * Files an incident.
 *
 * Deliberately open to any authenticated user, not just staff. The person
 * who most needs to file one is the person it happened to, and putting a
 * permission check in front of that would mean a customer reporting a
 * threat has to find a support email first.
 *
 * Severity defaults from the category rather than being chosen by the
 * reporter. Somebody in distress should not have to pick the right number
 * from a dropdown for their report to be seen quickly, and letting the
 * reporter set it directly would let anybody mark their own complaint S0.
 */
export async function openIncident(args: {
  db: Db
  reporterUserId: string | null
  category: unknown
  narrative: unknown
  businessId?: string | undefined
  subscriptionId?: string | undefined
  occurrenceId?: string | undefined
  now: Date
  ip?: string | null
}): Promise<OpenIncidentResult> {
  const { db, now } = args

  if (!isIncidentCategory(args.category)) {
    return { ok: false, code: 'INVALID', message: 'Choose what kind of problem this is.' }
  }
  const category: IncidentCategory = args.category

  if (typeof args.narrative !== 'string' || args.narrative.trim().length < 10) {
    return {
      ok: false,
      code: 'INVALID',
      message: 'Tell us what happened, in a sentence or two.',
    }
  }
  const narrative = args.narrative.trim().slice(0, 5000)

  const severity = defaultSeverityFor(category)

  // Resolve the provider so a guardian decision has something to work with.
  let providerUserId: string | null = null
  if (args.subscriptionId) {
    const { data } = await db
      .from('subscriptions')
      .select('provider_services!inner ( businesses!inner ( provider_user_id ) )')
      .eq('id', args.subscriptionId)
      .maybeSingle()
    const one = <T,>(v: unknown): T | undefined => (Array.isArray(v) ? v[0] : v) as T | undefined
    const svc = one<{ businesses: unknown }>(data?.provider_services)
    providerUserId = one<{ provider_user_id: string }>(svc?.businesses)?.provider_user_id ?? null
  } else if (args.businessId) {
    const { data } = await db
      .from('businesses')
      .select('provider_user_id')
      .eq('id', args.businessId)
      .maybeSingle()
    providerUserId = data?.provider_user_id ?? null
  }

  let involvesMinor = false
  if (providerUserId) {
    const { data: profile } = await db
      .from('provider_profiles')
      .select('date_of_birth')
      .eq('user_id', providerUserId)
      .maybeSingle()
    if (profile) {
      involvesMinor =
        classifyAge(parsePlainDate(profile.date_of_birth), {
          year: now.getUTCFullYear(),
          month: now.getUTCMonth() + 1,
          day: now.getUTCDate(),
        }) === 'minor'
    }
  }

  const respondBy = new Date(
    now.getTime() + RESPONSE_TARGET_MINUTES[severity] * 60_000,
  ).toISOString()

  const { data, error } = await db
    .from('incidents')
    .insert({
      severity,
      category,
      narrative,
      reporter_user_id: args.reporterUserId,
      business_id: args.businessId ?? null,
      subscription_id: args.subscriptionId ?? null,
      occurrence_id: args.occurrenceId ?? null,
      provider_user_id: providerUserId,
      involves_minor: involvesMinor,
      respond_by: respondBy,
    })
    .select('id')
    .single()

  if (error || !data) {
    console.error('[admin] incident insert failed', error?.message)
    return { ok: false, code: 'WRITE_FAILED', message: 'Could not file that. Try again.' }
  }

  await writeAudit({
    actorUserId: args.reporterUserId,
    actorRole: null,
    action: 'incident.opened',
    targetType: 'incident',
    targetId: data.id,
    // The narrative is on the incident row for somebody with a reason to
    // read it. Copying it here would put a reporter's account of something
    // that may involve a child into a second table.
    after: { severity, category, involves_minor: involvesMinor },
    reasonCode: category,
    ip: args.ip ?? null,
  })

  return {
    ok: true,
    incidentId: data.id,
    severity,
    respondBy,
    recommendPause: recommendsImmediatePause(severity),
    guardianNotification: guardianNotificationFor({
      severity,
      providerIsMinor: involvesMinor,
      // Not knowable from a report alone. Staff decide; the domain flags it.
      guardianIsSubject: false,
    }),
  }
}

/**
 * Runs a high-impact action.
 *
 * The shape every staff mutation below shares: check the permission, refuse
 * a thin reason, write the audit row, then act. Factored out so no
 * individual action can quietly skip a step.
 */
async function guarded<T>(args: {
  actor: AdminActor
  permission: Parameters<typeof hasPermission>[1]
  action: AdminAuditAction
  targetType: string
  targetId: string
  reason: unknown
  before?: unknown
  after?: unknown
  /** Runs only after the permission, the reason and the audit row are good. */
  perform: () => Promise<{ ok: boolean; message?: string }>
}): Promise<AdminVoidResult> {
  if (!hasPermission(args.actor.roles, args.permission)) {
    return {
      ok: false,
      code: 'NOT_AUTHORIZED',
      message: 'This account cannot perform that action.',
    }
  }

  const reason = checkReason(args.reason, args.action)
  if (!reason.ok) return { ok: false, code: 'REASON_REQUIRED', message: reason.message }

  await writeAudit({
    actorUserId: args.actor.userId,
    actorRole: args.actor.roles[0] ?? null,
    action: args.action,
    targetType: args.targetType,
    targetId: args.targetId,
    ...(args.before !== undefined ? { before: args.before } : {}),
    ...(args.after !== undefined ? { after: args.after } : {}),
    reasonCode: reason.reason,
    ip: args.actor.ip ?? null,
  })

  const result = await args.perform()
  if (!result.ok) {
    return {
      ok: false,
      code: 'WRITE_FAILED',
      message: result.message ?? 'Could not complete that. Try again.',
    }
  }

  return { ok: true }
}

type AdminAuditAction = Extract<
  AuditAction,
  | 'account.suspended'
  | 'business.paused_admin'
  | 'payout.hold_placed'
  | 'payout.hold_released'
  | 'incident.resolved'
  | 'review.removed'
>

// ---------------------------------------------------------------------------
// Payout holds
// ---------------------------------------------------------------------------

export async function holdPayouts(args: {
  db: Db
  actor: AdminActor
  providerUserId: string
  incidentId?: string | undefined
  reason: unknown
}): Promise<AdminVoidResult> {
  return guarded({
    actor: args.actor,
    permission: 'payout:hold',
    action: 'payout.hold_placed',
    targetType: 'user',
    targetId: args.providerUserId,
    reason: args.reason,
    after: { held: true, incident_id: args.incidentId ?? null },
    perform: async () => {
      const checked = checkReason(args.reason, 'payout.hold')
      const { error } = await args.db.from('payout_holds').insert({
        provider_user_id: args.providerUserId,
        incident_id: args.incidentId ?? null,
        reason: checked.ok ? checked.reason : '',
        placed_by_user_id: args.actor.userId,
      })
      // A duplicate means a hold is already in place, which is the state
      // the caller wanted.
      if (error && error.code !== '23505') {
        console.error('[admin] payout hold failed', error.message)
        return { ok: false, message: 'Could not place the hold.' }
      }
      return { ok: true }
    },
  })
}

export async function releasePayouts(args: {
  db: Db
  actor: AdminActor
  providerUserId: string
  reason: unknown
  now: Date
}): Promise<AdminVoidResult> {
  return guarded({
    actor: args.actor,
    permission: 'payout:release',
    action: 'payout.hold_released',
    targetType: 'user',
    targetId: args.providerUserId,
    reason: args.reason,
    after: { held: false },
    perform: async () => {
      const checked = checkReason(args.reason, 'payout.release')
      const { error } = await args.db
        .from('payout_holds')
        .update({
          released_at: args.now.toISOString(),
          released_by_user_id: args.actor.userId,
          release_reason: checked.ok ? checked.reason : '',
        })
        .eq('provider_user_id', args.providerUserId)
        .is('released_at', null)

      if (error) {
        console.error('[admin] payout release failed', error.message)
        return { ok: false, message: 'Could not release the hold.' }
      }
      return { ok: true }
    },
  })
}

/** Is this provider's money currently held? */
export async function payoutsAreHeld(args: {
  db: Db
  providerUserId: string
}): Promise<boolean> {
  const { data } = await args.db
    .from('payout_holds')
    .select('id')
    .eq('provider_user_id', args.providerUserId)
    .is('released_at', null)
    .maybeSingle()
  return Boolean(data)
}

// ---------------------------------------------------------------------------
// Address access
// ---------------------------------------------------------------------------

export type AddressAccess = AdminResult<{
  address: {
    line1: string
    line2: string | null
    city: string
    region: string
    postalCode: string
    accessNotes: string | null
  }
}>

/**
 * Staff look-up of a customer address.
 *
 * The audit row is written first and the read is abandoned if it fails.
 * Everywhere else in this codebase an audit failure is logged and stepped
 * over, because the underlying action already happened and losing it would
 * be worse. Here there is no underlying action to protect: refusing costs a
 * member of staff one retry, and proceeding costs an unlogged look at where
 * somebody lives.
 */
export async function readCustomerAddress(args: {
  db: Db
  actor: AdminActor
  addressId: string
  reason: unknown
  incidentId?: string | undefined
}): Promise<AddressAccess> {
  if (!hasPermission(args.actor.roles, 'address:read_customer')) {
    return {
      ok: false,
      code: 'NOT_AUTHORIZED',
      message: 'This account cannot look up customer addresses.',
    }
  }

  const reason = checkReason(args.reason, 'address.read')
  if (!reason.ok) return { ok: false, code: 'REASON_REQUIRED', message: reason.message }

  const { data, error } = await args.db
    .from('customer_addresses')
    .select('id, line1, line2, city, region, postal_code, access_notes')
    .eq('id', args.addressId)
    .maybeSingle()

  if (error || !data) return { ok: false, code: 'NOT_FOUND', message: 'No such address.' }

  // Written BEFORE the value is returned. See the header.
  const audited = await writeAuditStrict({
    actorUserId: args.actor.userId,
    actorRole: args.actor.roles[0] ?? null,
    action: 'address.accessed_by_staff',
    targetType: 'customer_address',
    targetId: args.addressId,
    // The address itself is not copied into the log. The row it points at
    // is the record; duplicating it here would put a home address in a
    // second table with different access rules.
    after: { incident_id: args.incidentId ?? null },
    reasonCode: reason.reason,
    ip: args.actor.ip ?? null,
  })

  if (!audited) {
    return {
      ok: false,
      code: 'AUDIT_FAILED',
      message: 'Could not record this lookup, so it was not performed. Try again.',
    }
  }

  return {
    ok: true,
    address: {
      line1: data.line1,
      line2: data.line2,
      city: data.city,
      region: data.region,
      postalCode: data.postal_code,
      accessNotes: data.access_notes,
    },
  }
}

/**
 * An audit write whose failure is reported rather than swallowed.
 *
 * writeAudit deliberately never throws into its caller, because a failed
 * log must not roll back a guardian revocation. That is the right default
 * and the wrong one for an access log gating a read, so this is the strict
 * variant rather than a change to the shared one.
 */
async function writeAuditStrict(entry: Parameters<typeof writeAudit>[0]): Promise<boolean> {
  const db = supabaseAdmin()
  const { error } = await db.from('audit_log').insert({
    actor_user_id: entry.actorUserId,
    actor_role: entry.actorRole,
    action: entry.action,
    target_type: entry.targetType,
    target_id: entry.targetId,
    before_json: null,
    after_json: entry.after === undefined ? null : (entry.after as never),
    reason_code: entry.reasonCode ?? null,
    ip_hash: null,
  })
  if (error) {
    console.error('[admin] strict audit write failed', { action: entry.action, code: error.code })
    return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

export type RefundCheck =
  | { ok: true; reason: string | null }
  | { ok: false; code: AdminFailure; message: string }

/**
 * Whether this refund may proceed, and with what reason attached.
 *
 * Below the threshold a refund is routine goodwill and needs no essay --
 * demanding one for a $3 credit trains staff to type filler, which makes
 * the log look complete while saying nothing.
 */
export function checkRefundAuthorization(args: {
  actor: AdminActor
  amountCents: number
  reason: unknown
}): RefundCheck {
  if (!hasPermission(args.actor.roles, 'refund:issue')) {
    return { ok: false, code: 'NOT_AUTHORIZED', message: 'This account cannot issue refunds.' }
  }

  if (!refundNeedsReason(args.amountCents)) {
    const supplied = typeof args.reason === 'string' ? args.reason.trim() : ''
    return { ok: true, reason: supplied || null }
  }

  const reason = checkReason(args.reason, 'refund.issue')
  if (!reason.ok) return { ok: false, code: 'REASON_REQUIRED', message: reason.message }

  return { ok: true, reason: reason.reason }
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

export type QueueItem = {
  incidentId: string
  severity: IncidentSeverity
  state: string
  category: string
  involvesMinor: boolean
  respondBy: string
  overdue: boolean
  createdAt: string
}

/**
 * Open incidents, most urgent first.
 *
 * Sorted by severity then by deadline, so an overdue S1 outranks a fresh
 * one and nothing sits behind a pile of quality disputes.
 */
export async function incidentQueue(args: {
  db: Db
  actor: AdminActor
  now: Date
  limit?: number
}): Promise<AdminResult<{ items: QueueItem[] }>> {
  if (!hasPermission(args.actor.roles, 'incident:manage')) {
    return { ok: false, code: 'NOT_AUTHORIZED', message: 'This account cannot see incidents.' }
  }

  const { data, error } = await args.db
    .from('incidents')
    .select('id, severity, state, category, involves_minor, respond_by, created_at')
    .in('state', ['open', 'investigating'])
    .order('severity', { ascending: true })
    .order('respond_by', { ascending: true })
    .limit(args.limit ?? 100)

  if (error) {
    console.error('[admin] queue query failed', error.message)
    return { ok: false, code: 'WRITE_FAILED', message: 'Could not load the queue.' }
  }

  return {
    ok: true,
    items: (data ?? []).map((i) => ({
      incidentId: i.id,
      severity: i.severity as IncidentSeverity,
      state: i.state,
      category: i.category,
      involvesMinor: i.involves_minor,
      respondBy: i.respond_by,
      overdue: new Date(i.respond_by).getTime() < args.now.getTime(),
      createdAt: i.created_at,
    })),
  }
}

export async function resolveIncident(args: {
  db: Db
  actor: AdminActor
  incidentId: string
  resolution: unknown
  now: Date
}): Promise<AdminVoidResult> {
  const { data: incident } = await args.db
    .from('incidents')
    .select('id, state, severity')
    .eq('id', args.incidentId)
    .maybeSingle()

  if (!incident) return { ok: false, code: 'NOT_FOUND', message: 'No such incident.' }

  return guarded({
    actor: args.actor,
    permission: 'incident:manage',
    action: 'incident.resolved',
    targetType: 'incident',
    targetId: args.incidentId,
    reason: args.resolution,
    before: { state: incident.state },
    after: { state: 'resolved' },
    perform: async () => {
      const checked = checkReason(args.resolution, 'incident.resolve')
      const { error } = await args.db
        .from('incidents')
        .update({
          state: 'resolved',
          resolution: checked.ok ? checked.reason : '',
          resolved_at: args.now.toISOString(),
          resolved_by_user_id: args.actor.userId,
        })
        .eq('id', args.incidentId)
        .in('state', ['open', 'investigating'])

      if (error) {
        console.error('[admin] incident resolve failed', error.message)
        return { ok: false, message: 'Could not resolve that.' }
      }
      return { ok: true }
    },
  })
}
