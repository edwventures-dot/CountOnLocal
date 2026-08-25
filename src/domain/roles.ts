/**
 * Roles and permissions.
 *
 * TECHNICAL_SPEC section 3: "Roles are additive permissions, not a single
 * is_admin flag. Authorization must be enforced server-side. Client-side
 * hiding is not authorization."
 *
 * So there is no wildcard. Even platform_admin holds an enumerated set --
 * if a new permission is added, every role that should hold it must be
 * edited deliberately. A `'*'` shortcut here would quietly re-introduce the
 * is_admin flag the spec forbids.
 */

export type Role =
  | 'provider'
  | 'guardian'
  | 'customer'
  | 'support_agent'
  | 'trust_safety_agent'
  | 'finance_admin'
  | 'platform_admin'

export type Permission =
  // provider surface
  | 'business:draft'
  | 'business:publish'
  | 'business:pause_own'
  | 'service:configure'
  // guardian surface
  | 'guardian:invite'
  | 'guardian:accept'
  | 'guardian:revoke'
  | 'guardian:pause_business'
  | 'guardian:view_linked_operations'
  // customer surface
  | 'subscription:create'
  | 'subscription:cancel_own'
  // sensitive reads -- every one of these is audited at the call site
  | 'address:read_customer'
  | 'identity:read_sensitive'
  // staff actions
  | 'incident:manage'
  | 'moderation:act'
  | 'account:suspend'
  | 'payout:hold'
  | 'payout:release'
  | 'refund:issue'
  | 'flags:manage'
  | 'catalog:manage'
  | 'role:grant'
  | 'audit:read'

/**
 * support_agent is deliberately thin. PRD section 5 defines it as
 * "assistance without unrestricted access to sensitive identity data",
 * so it gets neither address:read_customer nor identity:read_sensitive.
 * Escalation to trust_safety_agent is the intended path, and it leaves a
 * trail.
 */
const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  // The provider invites their own guardian -- API_CONTRACT, POST
  // /v1/guardian/invitations is a provider action. Accepting and revoking
  // belong to the guardian, never to the provider.
  provider: [
    'business:draft',
    'business:publish',
    'business:pause_own',
    'service:configure',
    'guardian:invite',
  ],

  guardian: [
    'guardian:accept',
    'guardian:revoke',
    'guardian:pause_business',
    'guardian:view_linked_operations',
  ],

  customer: ['subscription:create', 'subscription:cancel_own'],

  support_agent: ['incident:manage'],

  trust_safety_agent: [
    'incident:manage',
    'moderation:act',
    'account:suspend',
    'address:read_customer',
    'identity:read_sensitive',
    'payout:hold',
  ],

  finance_admin: ['payout:hold', 'payout:release', 'refund:issue', 'audit:read'],

  platform_admin: [
    'flags:manage',
    'catalog:manage',
    'role:grant',
    'audit:read',
    'account:suspend',
    'moderation:act',
    'incident:manage',
  ],
}

export function permissionsFor(roles: Iterable<Role>): ReadonlySet<Permission> {
  const out = new Set<Permission>()
  for (const role of roles) for (const p of ROLE_PERMISSIONS[role]) out.add(p)
  return out
}

export function hasPermission(roles: Iterable<Role>, permission: Permission): boolean {
  for (const role of roles) if (ROLE_PERMISSIONS[role].includes(permission)) return true
  return false
}

/** Permissions whose use must be written to the audit log -- CLAUDE.md rule 9. */
export const AUDITED_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  'address:read_customer',
  'identity:read_sensitive',
  'guardian:revoke',
  'account:suspend',
  'payout:hold',
  'payout:release',
  'refund:issue',
  'role:grant',
  'moderation:act',
  'catalog:manage',
  'flags:manage',
])

export function requiresAudit(permission: Permission): boolean {
  return AUDITED_PERMISSIONS.has(permission)
}
