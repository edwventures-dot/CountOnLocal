/**
 * Request authentication and role loading.
 *
 * TECHNICAL_SPEC section 3: authorization is enforced server-side, and
 * roles are additive. Every handler starts here; nothing trusts a role,
 * an id, or an age supplied in a request body.
 */

import { createSupabaseServerClient } from '@/lib/supabase/server'
import type { Role } from '@/domain/roles'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'

export type AuthedRequest = {
  userId: string
  roles: Role[]
  db: SupabaseClient<Database>
}

export type AuthResult = { ok: true; auth: AuthedRequest } | { ok: false; code: 'UNAUTHENTICATED' }

/**
 * Resolves the caller from the verified session cookie, then loads their
 * roles from the database rather than from the token, so a role revoked a
 * moment ago does not survive in an unexpired JWT.
 */
export async function authenticate(): Promise<AuthResult> {
  const db = await createSupabaseServerClient()

  const {
    data: { user },
  } = await db.auth.getUser()

  if (!user) return { ok: false, code: 'UNAUTHENTICATED' }

  const { data: roleRows } = await db.from('user_roles').select('role').eq('user_id', user.id)

  const roles: Role[] = (roleRows ?? []).map((r) => r.role)

  return { ok: true, auth: { userId: user.id, roles, db } }
}

/** Client IP for audit hashing. Never stored raw. */
export function clientIp(req: Request): string | null {
  const forwarded = req.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0]?.trim() ?? null
  return req.headers.get('x-real-ip')
}
