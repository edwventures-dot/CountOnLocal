import { describe, it, expect } from 'vitest'
import {
  permissionsFor,
  hasPermission,
  requiresAudit,
  AUDITED_PERMISSIONS,
  type Role,
} from '../roles.js'

describe('permissions are additive', () => {
  it('unions the permissions of every held role', () => {
    const p = permissionsFor(['provider', 'customer'])
    expect(p.has('business:publish')).toBe(true)
    expect(p.has('subscription:create')).toBe(true)
  })

  it('grants nothing for no roles', () => {
    expect(permissionsFor([]).size).toBe(0)
  })
})

describe('no is_admin flag - TECHNICAL_SPEC section 3', () => {
  it('platform_admin does not hold every permission', () => {
    const admin = permissionsFor(['platform_admin'])
    // A wildcard would sweep these in; an enumerated set does not.
    expect(admin.has('address:read_customer')).toBe(false)
    expect(admin.has('identity:read_sensitive')).toBe(false)
    expect(admin.has('refund:issue')).toBe(false)
  })

  it('no single role can do everything', () => {
    const roles: Role[] = [
      'provider',
      'guardian',
      'customer',
      'support_agent',
      'trust_safety_agent',
      'finance_admin',
      'platform_admin',
    ]
    const everything = permissionsFor(roles)
    for (const r of roles) {
      expect(permissionsFor([r]).size).toBeLessThan(everything.size)
    }
  })
})

describe('support_agent is restricted - PRD section 5', () => {
  it('cannot reach sensitive identity or address data', () => {
    expect(hasPermission(['support_agent'], 'address:read_customer')).toBe(false)
    expect(hasPermission(['support_agent'], 'identity:read_sensitive')).toBe(false)
  })

  it('can still handle incidents', () => {
    expect(hasPermission(['support_agent'], 'incident:manage')).toBe(true)
  })
})

describe('providers cannot act as their own guardian', () => {
  it('the provider role carries no guardian permissions', () => {
    const p = permissionsFor(['provider'])
    expect(p.has('guardian:accept')).toBe(false)
    expect(p.has('guardian:revoke')).toBe(false)
  })
})

describe('audited permissions - CLAUDE.md rule 9', () => {
  it('flags every sensitive action', () => {
    for (const p of ['address:read_customer', 'guardian:revoke', 'payout:hold', 'role:grant'] as const) {
      expect(requiresAudit(p)).toBe(true)
    }
  })

  it('does not flag ordinary provider work', () => {
    expect(requiresAudit('business:draft')).toBe(false)
    expect(requiresAudit('subscription:create')).toBe(false)
  })

  it('audits every staff permission that touches money or identity', () => {
    for (const p of AUDITED_PERMISSIONS) expect(requiresAudit(p)).toBe(true)
  })
})
