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

/**
 * Which of a caller's roles actually authorised an action.
 *
 * The audit log records a role alongside the actor, and it used to record
 * `roles[0]` -- whichever the database happened to return first. That was
 * right by accident while staff accounts held exactly one role. Migration
 * 0028 grants `customer` to every account, so a trust and safety agent
 * resolving an incident started being logged as a customer, which corrupts
 * the one record the console exists to produce.
 *
 * The honest answer is the role that grants the permission being used. Ties
 * are broken by ROLE_PRECEDENCE, most privileged first, so somebody holding
 * both finance_admin and support_agent releasing a payout is recorded as
 * the finance_admin they were acting as.
 *
 * Returns null when no role grants it. Callers should already have refused
 * by then; recording null beats recording a role that did not apply.
 */
const ROLE_PRECEDENCE: readonly Role[] = [
  'platform_admin',
  'finance_admin',
  'trust_safety_agent',
  'support_agent',
  'guardian',
  'provider',
  'customer',
]

export function roleGranting(roles: readonly Role[], permission: Permission): Role | null {
  for (const role of ROLE_PRECEDENCE) {
    if (roles.includes(role) && ROLE_PERMISSIONS[role].includes(permission)) return role
  }
  return null
}
