/**
 * Guardian invitation tokens.
 *
 * The token is the credential that lets someone consent on behalf of a
 * minor's guardian, so it gets treated like one: high entropy, stored only
 * as a hash, compared in constant time, and given an expiry.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** Days an invitation stays live before it becomes `expired`. */
export const INVITATION_TTL_DAYS = 14

export function generateInvitationToken(): string {
  // 32 bytes of entropy, url-safe.
  return randomBytes(32).toString('base64url')
}

export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function tokensMatch(candidateToken: string, storedHash: string): boolean {
  const a = Buffer.from(hashInvitationToken(candidateToken), 'hex')
  const b = Buffer.from(storedHash, 'hex')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export function invitationExpiryFrom(now: Date): Date {
  return new Date(now.getTime() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000)
}

export function isExpired(expiresAt: string | null, now: Date): boolean {
  if (expiresAt === null) return false
  return new Date(expiresAt).getTime() <= now.getTime()
}
