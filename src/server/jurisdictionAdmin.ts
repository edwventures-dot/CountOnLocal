/**
 * Staff writes to the jurisdiction table.
 *
 * The read path is in jurisdictionService.ts. This is the other half: the
 * handle on the lever, which the lever was missing.
 *
 * Migration 0040 gives nobody an insert or update policy, so every write
 * here runs as the service role behind a permission check and an audit
 * row. That is the same shape as every other staff action in this codebase
 * and for the same reason: on a platform with minors on it, the point of
 * staff tooling is not speed, it is that somebody can reconstruct months
 * later who closed a state and why.
 *
 * ## Why closing a state is not a delete-and-reinsert
 *
 * Lifting a restriction updates the row rather than removing it. "When were
 * we closed in Ohio, and who decided" has to stay answerable — a regulator
 * asking that question is the most likely reason anybody ever reads this
 * table.
 */

import { checkReason } from '@/domain/incident'
import { normaliseRegion } from '@/domain/jurisdiction'
import { hasPermission, type Role } from '@/domain/roles'
import { writeAudit } from '@/server/audit'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'

type Db = SupabaseClient<Database>

/**
 * US states and territories, so a typo cannot close a state that does not
 * exist — or worse, silently fail to close one that does because somebody
 * typed a lowercase or three-letter code.
 *
 * The schema constrains the shape (two uppercase letters); this constrains
 * the meaning.
 */
export const US_REGIONS = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI',
  'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN',
  'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH',
  'OK', 'OR', 'PA', 'PR', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA',
  'VI', 'WA', 'WV', 'WI', 'WY',
] as const

export type JurisdictionAdminResult =
  | { ok: true; id: string }
  | {
      ok: false
      code: 'NOT_AUTHORIZED' | 'INVALID_REGION' | 'REASON_TOO_SHORT' | 'ALREADY_SET' | 'NOT_FOUND' | 'WRITE_FAILED'
      message: string
    }

/**
 * Close or clear a state, optionally for one service only.
 *
 * Which permission this needs is worth stating: it is the same one that
 * gates the trust and safety console. A jurisdiction restriction is a
 * safety control — it exists because a state's rules about minors working
 * have not been satisfied — and not a billing setting.
 */
export async function setJurisdictionRule(args: {
  db: Db
  actorUserId: string
  actorRoles: Role[]
  region: string
  status: 'allowed' | 'blocked'
  catalogCode?: string | undefined
  reason: string
  ip?: string | undefined
}): Promise<JurisdictionAdminResult> {
  if (!hasPermission(args.actorRoles, 'incident:manage')) {
    return { ok: false, code: 'NOT_AUTHORIZED', message: 'You cannot change availability.' }
  }

  const region = normaliseRegion(args.region)
  if (!(US_REGIONS as readonly string[]).includes(region)) {
    return { ok: false, code: 'INVALID_REGION', message: `${region} is not a US state code.` }
  }

  const reasonCheck = checkReason(args.reason, 'Changing where the platform operates')
  if (!reasonCheck.ok) {
    return { ok: false, code: 'REASON_TOO_SHORT', message: reasonCheck.message }
  }

  const { data, error } = await args.db
    .from('jurisdiction_rules')
    .insert({
      region,
      status: args.status,
      catalog_code: args.catalogCode ?? null,
      reason: args.reason.trim(),
      created_by_user_id: args.actorUserId,
    })
    .select('id')
    .single()

  if (error) {
    // The partial unique index. A second live rule for the same state and
    // service would make the answer depend on row order, so the database
    // refuses it -- and the operator needs to be told to lift the existing
    // one rather than being shown a raw constraint name.
    if (error.message.includes('ux_jurisdiction_live')) {
      return {
        ok: false,
        code: 'ALREADY_SET',
        message: `There is already a live rule for ${region}${args.catalogCode ? ` and ${args.catalogCode}` : ''}. Lift it first.`,
      }
    }
    console.error('[jurisdiction] write failed', error.message)
    return { ok: false, code: 'WRITE_FAILED', message: 'That did not save.' }
  }

  await writeAudit({
    actorUserId: args.actorUserId,
    actorRole: args.actorRoles.join(','),
    action: args.status === 'blocked' ? 'jurisdiction.blocked' : 'jurisdiction.allowed',
    targetType: 'jurisdiction',
    targetId: region,
    reasonCode: 'jurisdiction_change',
    after: {
      region,
      status: args.status,
      catalog_code: args.catalogCode ?? null,
      reason: args.reason.trim(),
    },
    ...(args.ip === undefined ? {} : { ip: args.ip }),
  })

  return { ok: true, id: data.id }
}

/** Lift a live rule. The row stays; only its lifted_at is set. */
export async function liftJurisdictionRule(args: {
  db: Db
  actorUserId: string
  actorRoles: Role[]
  ruleId: string
  reason: string
  now: Date
  ip?: string | undefined
}): Promise<JurisdictionAdminResult> {
  if (!hasPermission(args.actorRoles, 'incident:manage')) {
    return { ok: false, code: 'NOT_AUTHORIZED', message: 'You cannot change availability.' }
  }

  const reasonCheck = checkReason(args.reason, 'Lifting a restriction')
  if (!reasonCheck.ok) {
    return { ok: false, code: 'REASON_TOO_SHORT', message: reasonCheck.message }
  }

  const { data, error } = await args.db
    .from('jurisdiction_rules')
    .update({
      lifted_at: args.now.toISOString(),
      lifted_by_user_id: args.actorUserId,
      lift_reason: args.reason.trim(),
    })
    .eq('id', args.ruleId)
    // Only a live rule. Lifting an already-lifted one would rewrite who
    // lifted it and when, which is the history this table exists to keep.
    .is('lifted_at', null)
    .select('id, region, status, catalog_code')
    .maybeSingle()

  if (error) {
    console.error('[jurisdiction] lift failed', error.message)
    return { ok: false, code: 'WRITE_FAILED', message: 'That did not save.' }
  }
  if (!data) {
    return { ok: false, code: 'NOT_FOUND', message: 'That rule is not live.' }
  }

  await writeAudit({
    actorUserId: args.actorUserId,
    actorRole: args.actorRoles.join(','),
    action: 'jurisdiction.lifted',
    targetType: 'jurisdiction',
    targetId: data.region,
    reasonCode: 'jurisdiction_change',
    before: { status: data.status, catalog_code: data.catalog_code },
    after: { lifted: true, reason: args.reason.trim() },
    ...(args.ip === undefined ? {} : { ip: args.ip }),
  })

  return { ok: true, id: data.id }
}

export type LiveRule = {
  id: string
  region: string
  status: string
  catalogCode: string | null
  reason: string
  createdAt: string
}

/** Every rule currently in force, for the console. */
export async function listLiveRules(db: Db): Promise<LiveRule[]> {
  const { data } = await db
    .from('jurisdiction_rules')
    .select('id, region, status, catalog_code, reason, created_at')
    .is('lifted_at', null)
    .order('region')

  return (data ?? []).map((r) => ({
    id: r.id,
    region: r.region,
    status: r.status,
    catalogCode: r.catalog_code,
    reason: r.reason,
    createdAt: r.created_at,
  }))
}

/**
 * Change the posture.
 *
 * Separate from the rules on purpose, and deliberately awkward to reach:
 * flipping this to `allowlist` closes every state nobody has explicitly
 * cleared, which is the single most consequential switch in the product.
 */
export async function setPosture(args: {
  db: Db
  actorUserId: string
  actorRoles: Role[]
  posture: 'open' | 'allowlist'
  reason: string
  now: Date
  ip?: string | undefined
}): Promise<JurisdictionAdminResult> {
  if (!hasPermission(args.actorRoles, 'incident:manage')) {
    return { ok: false, code: 'NOT_AUTHORIZED', message: 'You cannot change availability.' }
  }
  const reasonCheck = checkReason(args.reason, 'Changing the launch posture')
  if (!reasonCheck.ok) {
    return { ok: false, code: 'REASON_TOO_SHORT', message: reasonCheck.message }
  }

  const { error } = await args.db
    .from('platform_settings')
    .update({
      value: args.posture,
      updated_at: args.now.toISOString(),
      updated_by_user_id: args.actorUserId,
    })
    .eq('key', 'jurisdiction_posture')

  if (error) {
    console.error('[jurisdiction] posture write failed', error.message)
    return { ok: false, code: 'WRITE_FAILED', message: 'That did not save.' }
  }

  await writeAudit({
    actorUserId: args.actorUserId,
    actorRole: args.actorRoles.join(','),
    action: 'jurisdiction.posture_changed',
    targetType: 'platform_setting',
    targetId: 'jurisdiction_posture',
    reasonCode: 'jurisdiction_change',
    after: { posture: args.posture, reason: args.reason.trim() },
    ...(args.ip === undefined ? {} : { ip: args.ip }),
  })

  return { ok: true, id: 'jurisdiction_posture' }
}
