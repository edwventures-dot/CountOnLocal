import { describe, expect, it } from 'vitest'
import { prelaunchAllows, prelaunchGateEnabled, PRELAUNCH_ALLOWED } from '../prelaunch'

describe('prelaunchGateEnabled', () => {
  it('is on in production when nothing is set -- fail closed', () => {
    expect(prelaunchGateEnabled({ NODE_ENV: 'production' })).toBe(true)
  })

  it('stays off in development so the rest of the product is workable', () => {
    expect(prelaunchGateEnabled({ NODE_ENV: 'development' })).toBe(false)
  })

  it('lifts only on an explicit off', () => {
    expect(prelaunchGateEnabled({ NODE_ENV: 'production', PRELAUNCH: 'off' })).toBe(false)
    expect(prelaunchGateEnabled({ NODE_ENV: 'production', PRELAUNCH: 'OFF' })).toBe(false)
    expect(prelaunchGateEnabled({ NODE_ENV: 'production', PRELAUNCH: ' off ' })).toBe(false)
  })

  it('can be rehearsed in development', () => {
    expect(prelaunchGateEnabled({ NODE_ENV: 'development', PRELAUNCH: 'on' })).toBe(true)
  })

  it('treats a garbled value as gated in production, not as off', () => {
    // "false", "0" and "no" all read as intent to disable, but none of them
    // are the documented word. In production the safe reading is "gated".
    for (const v of ['false', '0', 'no', 'disabled', '']) {
      expect(prelaunchGateEnabled({ NODE_ENV: 'production', PRELAUNCH: v })).toBe(true)
    }
  })
})

describe('prelaunchAllows', () => {
  it('allows exactly the landing page and the waitlist endpoint', () => {
    expect(prelaunchAllows('/')).toBe(true)
    expect(prelaunchAllows('/api/v1/waitlist')).toBe(true)
    expect(PRELAUNCH_ALLOWED.size).toBe(2)
  })

  it('blocks the marketplace that is not cleared to launch', () => {
    for (const p of [
      '/api/v1/subscriptions',
      '/api/v1/checkout/preview',
      '/api/v1/provider/payouts/status',
      '/api/v1/guardian/invitations',
      '/api/webhooks/stripe',
      '/api/v1/catalog',
      '/jakesbinservice',
    ]) {
      expect(prelaunchAllows(p)).toBe(false)
    }
  })

  it('normalises a trailing slash so it cannot slip past the set check', () => {
    expect(prelaunchAllows('/api/v1/waitlist/')).toBe(true)
  })

  it('does not treat a prefix as a match', () => {
    expect(prelaunchAllows('/api/v1/waitlist/export')).toBe(false)
    expect(prelaunchAllows('/api/v1/waitlists')).toBe(false)
  })

  it('is not fooled by a path that merely starts at root', () => {
    expect(prelaunchAllows('/admin')).toBe(false)
  })
})
