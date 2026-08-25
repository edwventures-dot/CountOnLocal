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
  /**
   * The DOMAIN user id -- public.users.id -- which is what every foreign
   * key in the schema references. Deliberately not the Supabase auth id.
   */
  userId: string
  /** The auth provider's id, kept for auth-layer calls only. */
  authUserId: string
  roles: Role[]
  db: SupabaseClient<Database>
}

export type AuthResult =
  | { ok: true; auth: AuthedRequest }
  | { ok: false; code: 'UNAUTHENTICATED' | 'NO_DOMAIN_USER' }

/**
 * Resolves the caller from the verified session cookie.
 *
 * Two ids are in play and confusing them is a real hazard: auth.users.id
 * identifies the credential, public.users.id is what provider_profiles,
 * guardian_relationships and audit_log all point at. Returning the auth id
 * here caused every write to fail on a foreign key constraint, which is why
 * the mapping is done once, here, and the auth id is exposed under a name
 * that cannot be mistaken for the other.
 *
 * The lookup runs through the user-scoped client, so the row level policy
 * on users -- id = app_current_user_id() -- does the matching. A caller can
 * only ever resolve to their own domain user.
 *
 * Roles are read from the database rather than the token, so a role revoked
 * a moment ago does not survive in an unexpired JWT.
 */
export async function authenticate(): Promise<AuthResult> {
  const db = await createSupabaseServerClient()

  const {
    data: { user },
  } = await db.auth.getUser()

  if (!user) return { ok: false, code: 'UNAUTHENTICATED' }

  const { data: domainUser } = await db.from('users').select('id').maybeSingle()

  // Migration 0003 provisions this row by trigger the moment an auth user is
  // created, so its absence means something is genuinely wrong rather than
  // that the account is merely new.
  if (!domainUser) return { ok: false, code: 'NO_DOMAIN_USER' }

  const { data: roleRows } = await db.from('user_roles').select('role').eq('user_id', domainUser.id)

  const roles: Role[] = (roleRows ?? []).map((r) => r.role)

  return { ok: true, auth: { userId: domainUser.id, authUserId: user.id, roles, db } }
}

/** Client IP for audit hashing. Never stored raw. */
export function clientIp(req: Request): string | null {
  const forwarded = req.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0]?.trim() ?? null
  return req.headers.get('x-real-ip')
}
