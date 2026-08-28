/**
 * Shared route plumbing.
 *
 * Every handler authenticates, checks a permission, validates, delegates,
 * and maps a result code to a status. Doing that inline in each file drifts;
 * doing it here keeps the auth and error shapes identical across routes.
 */

import { authenticate, type AuthedRequest } from '@/server/auth'
import { apiError, newRequestId } from '@/lib/http'
import { hasPermission, type Permission } from '@/domain/roles'

export type Guarded =
  | { ok: true; auth: AuthedRequest; requestId: string }
  | { ok: false; response: Response }

export async function guard(permission: Permission): Promise<Guarded> {
  const requestId = newRequestId()

  const auth = await authenticate()
  if (!auth.ok) {
    if (auth.code === 'NO_DOMAIN_USER') {
      return {
        ok: false,
        response: apiError(
          'ACCOUNT_NOT_PROVISIONED',
          'This account needs review. Please contact support.',
          409,
          { requestId },
        ),
      }
    }
    return {
      ok: false,
      response: apiError('UNAUTHENTICATED', 'Sign in to continue.', 401, { requestId }),
    }
  }

  // A suspended or closed account can still read its own pages -- it needs
  // to, to find out what happened -- but cannot take any permissioned
  // action. Checked here rather than at sign-in so a suspension applied
  // mid-session takes effect on the next request.
  //
  // users.status existed from migration 0001 and nothing read it until
  // now, which meant a suspended account could do everything an active one
  // could.
  if (auth.auth.status !== 'active') {
    return {
      ok: false,
      response: apiError(
        'ACCOUNT_NOT_ACTIVE',
        auth.auth.status === 'closed'
          ? 'This account has been closed. Contact support if you think that is wrong.'
          : 'This account is suspended while we look into a report.',
        403,
        { requestId },
      ),
    }
  }

  if (!hasPermission(auth.auth.roles, permission)) {
    return {
      ok: false,
      response: apiError('NOT_AUTHORIZED', 'This account cannot perform that action.', 403, {
        requestId,
      }),
    }
  }

  return { ok: true, auth: auth.auth, requestId }
}

export async function parseJson(req: Request): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    const text = await req.text()
    return { ok: true, body: text ? JSON.parse(text) : {} }
  } catch {
    return { ok: false }
  }
}

export function fieldErrorsFrom(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>) {
  const out: Record<string, string> = {}
  for (const i of issues) out[i.path.map(String).join('.') || 'body'] = i.message
  return out
}
