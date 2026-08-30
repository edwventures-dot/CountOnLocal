/**
 * Reading the jurisdiction rules, and applying them.
 *
 * The rules themselves live in the database (migration 0040) and the logic
 * for reading them in the right order lives in src/domain/jurisdiction.ts.
 * This is the thin layer between.
 *
 * ## Failing closed, and only here
 *
 * If the rules cannot be loaded, this refuses. That is the opposite of the
 * usual instinct -- most degraded paths in this codebase let the ordinary
 * case through -- and it is deliberate: the failure mode of guessing wrong
 * is selling a service to a minor in a state that prohibits it, which is
 * not something a retry fixes.
 *
 * It is also the reason the check sits in front of the geocoder rather than
 * behind it. A refusal costs nothing; a geocoder call for an address we
 * cannot serve costs money and tells a third party about somebody's house.
 */

import {
  checkJurisdiction,
  type JurisdictionCheck,
  type JurisdictionPosture,
  type JurisdictionRule,
} from '@/domain/jurisdiction'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'

type Db = SupabaseClient<Database>

export type LoadedRules = {
  rules: JurisdictionRule[]
  posture: JurisdictionPosture
}

/**
 * Everything the check needs, in two queries.
 *
 * Not cached. The whole point of this table is that somebody can close a
 * state and have it take effect, and a cache measured in minutes is a
 * window in which the platform keeps selling into it. Both queries are
 * indexed and the table has tens of rows.
 */
export async function loadJurisdictionRules(db: Db): Promise<LoadedRules | null> {
  const [rulesResult, postureResult] = await Promise.all([
    db
      .from('jurisdiction_rules')
      .select('region, status, catalog_code, reason')
      .is('lifted_at', null),
    db.from('platform_settings').select('value').eq('key', 'jurisdiction_posture').maybeSingle(),
  ])

  // Null rather than an empty list: "no restrictions" and "we could not
  // find out" must not look the same to the caller.
  if (rulesResult.error) {
    console.error('[jurisdiction] could not load rules', rulesResult.error.message)
    return null
  }

  const raw = postureResult.data?.value
  // An unrecognised value is treated as the safer posture rather than
  // silently falling back to open. Somebody typing 'allow_list' into the
  // settings table should get a closed platform and a phone call, not an
  // open one and no signal at all.
  const posture: JurisdictionPosture =
    raw === 'open' ? 'open' : raw === 'allowlist' ? 'allowlist' : 'allowlist'

  if (raw !== 'open' && raw !== 'allowlist') {
    console.error('[jurisdiction] unrecognised posture, defaulting to allowlist', { raw })
  }

  return {
    rules: (rulesResult.data ?? []).map((r) => ({
      region: r.region,
      status: r.status as JurisdictionRule['status'],
      catalogCode: r.catalog_code ?? undefined,
      reason: r.reason,
    })),
    posture,
  }
}

/** May this service be sold at an address in this state? */
export async function checkRegionAllowed(args: {
  db: Db
  region: string
  catalogCode?: string | undefined
}): Promise<JurisdictionCheck> {
  const loaded = await loadJurisdictionRules(args.db)

  if (!loaded) {
    return {
      allowed: false,
      code: 'STATE_NOT_CLEARED',
      message: 'We cannot check availability in your area right now. Please try again shortly.',
    }
  }

  return checkJurisdiction({
    region: args.region,
    ...(args.catalogCode === undefined ? {} : { catalogCode: args.catalogCode }),
    rules: loaded.rules,
    posture: loaded.posture,
  })
}
