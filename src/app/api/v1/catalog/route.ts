/**
 * GET /v1/catalog
 *
 * The menu a provider chooses from. Public, because it is the same list the
 * marketing site describes -- but read through the anon client so row level
 * security, not this handler, decides what "active" means.
 */

import { createClient } from '@supabase/supabase-js'
import { publicEnv } from '@/lib/env'
import { apiOk } from '@/lib/http'
import type { Database } from '@/lib/supabase/types'

export async function GET(): Promise<Response> {
  const env = publicEnv()
  const db = createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data } = await db
    .from('service_catalog')
    .select('code, name, description, risk_tier, min_provider_age, guardian_explicit_approval')
    .order('risk_tier')
    .order('name')

  return apiOk({
    services: (data ?? []).map((s) => ({
      code: s.code,
      name: s.name,
      description: s.description,
      riskTier: s.risk_tier,
      minProviderAge: s.min_provider_age,
      guardianApprovalRequired: s.guardian_explicit_approval,
    })),
  })
}
