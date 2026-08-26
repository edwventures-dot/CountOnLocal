import { describe, expect, it } from 'vitest'
import {
  backoffSeconds,
  checkDraft,
  checkPreviewText,
  isNotificationKind,
  MAX_ATTEMPTS,
  shouldGiveUp,
  UNSUPPRESSIBLE_KINDS,
  type DraftNotification,
} from '../notification'

const base: DraftNotification = {
  kind: 'subscription.new_subscriber',
  channel: 'email',
  destination: 'jake@example.com',
}

describe('an address never reaches a lock screen', () => {
  it.each([
    '742 Evergreen Terrace',
    'Your visit at 100 Oak St is tomorrow',
    'Heading to 1600 Pennsylvania Avenue',
    'Stop 3: 25 Elm Rd',
    '900 Outside Ave.',
  ])('refuses %s', (text) => {
    const r = checkPreviewText(text, 200)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('looks_like_address')
  })

  it('refuses a ZIP, which pins it to a neighbourhood', () => {
    const r = checkPreviewText('New customer in 78701', 200)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('looks_like_address')
  })

  it('allows a neighbourhood name, which is the public label anyway', () => {
    expect(checkPreviewText('New customer in Oak Ridge', 200).ok).toBe(true)
  })
})

describe('an access code never reaches a lock screen', () => {
  it.each([
    'Gate code 4417 for tomorrow',
    'access code: 8891',
    'Use keypad 1234 at the side door',
    'Entry pin 0000 as before',
    'The door code is 55123',
  ])('refuses %s', (text) => {
    const r = checkPreviewText(text, 200)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('looks_like_access_code')
  })

  it('still allows ordinary numbers', () => {
    // The whole point of a completion notice is the numbers in it.
    expect(checkPreviewText('18 of 18 stops done', 200).ok).toBe(true)
    expect(checkPreviewText('You earned $54.00 today', 200).ok).toBe(true)
    expect(checkPreviewText('Next service Tuesday', 200).ok).toBe(true)
  })

  it('does not trip on the word code with no digits', () => {
    expect(checkPreviewText('Your discount code arrived', 200).ok).toBe(true)
  })
})

describe('length and emptiness', () => {
  it('refuses an empty subject', () => {
    const r = checkPreviewText('   ', 120)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('empty')
  })

  it('refuses an over-long one and says by how much', () => {
    const r = checkPreviewText('x'.repeat(130), 120)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('too_long')
      expect(r.message).toContain('130')
    }
  })
})

describe('checkDraft', () => {
  it('accepts a plain notification', () => {
    expect(
      checkDraft({
        ...base,
        subject: 'You have a new customer',
        preview: 'Someone in Oak Ridge subscribed to your Tuesday route.',
      }).ok,
    ).toBe(true)
  })

  it('names the offending field', () => {
    const r = checkDraft({ ...base, subject: 'Visit at 100 Oak St' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.field).toBe('subject')
  })

  it('checks the preview as well as the subject', () => {
    const r = checkDraft({ ...base, subject: 'Tomorrow', preview: 'Gate code 4417' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.field).toBe('preview')
  })

  it('refuses an empty destination', () => {
    const r = checkDraft({ ...base, destination: '  ' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.field).toBe('destination')
  })
})

describe('the payload carries ids, not values', () => {
  it('accepts ids', () => {
    expect(
      checkDraft({
        ...base,
        payload: { subscriptionId: 'sub_1', occurrenceId: 'occ_2', amountCents: 1380 },
      }).ok,
    ).toBe(true)
  })

  it.each([
    ['access_notes', { access_notes: 'Gate 4417' }],
    ['gateCode', { gateCode: '4417' }],
    ['line1', { line1: '742 Evergreen Terrace' }],
    ['dateOfBirth', { dateOfBirth: '2011-04-02' }],
    ['token', { token: 'abc123' }],
  ])('refuses %s', (_label, payload) => {
    const r = checkDraft({ ...base, payload })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.field).toBe('payload')
  })

  it('finds a forbidden key nested inside an object', () => {
    const r = checkDraft({ ...base, payload: { stop: { address: { line1: '1 Oak St' } } } })
    expect(r.ok).toBe(false)
  })

  it('finds one inside an array', () => {
    const r = checkDraft({ ...base, payload: { stops: [{ id: 'a' }, { gate_code: '1234' }] } })
    expect(r.ok).toBe(false)
  })

  it('does not recurse forever on a deeply nested payload', () => {
    let nested: Record<string, unknown> = { id: 'x' }
    for (let i = 0; i < 50; i++) nested = { child: nested }
    expect(() => checkDraft({ ...base, payload: nested })).not.toThrow()
  })
})

describe('kinds', () => {
  it('recognises the PRD section 20 events', () => {
    expect(isNotificationKind('subscription.payment_failed')).toBe(true)
    expect(isNotificationKind('guardian.approval_requested')).toBe(true)
  })

  it('rejects anything invented', () => {
    expect(isNotificationKind('marketing.blast')).toBe(false)
    expect(isNotificationKind('')).toBe(false)
    expect(isNotificationKind(null)).toBe(false)
  })

  it('will not let a safety alert or a payment failure be suppressed', () => {
    expect(UNSUPPRESSIBLE_KINDS.has('safety.alert')).toBe(true)
    expect(UNSUPPRESSIBLE_KINDS.has('subscription.payment_failed')).toBe(true)
    expect(UNSUPPRESSIBLE_KINDS.has('guardian.revoked')).toBe(true)
  })

  it('leaves ordinary updates suppressible', () => {
    expect(UNSUPPRESSIBLE_KINDS.has('occurrence.completed')).toBe(false)
    expect(UNSUPPRESSIBLE_KINDS.has('review.received')).toBe(false)
  })
})

describe('retry backoff', () => {
  it('does not wait before the first attempt', () => {
    expect(backoffSeconds(0)).toBe(0)
  })

  it('grows', () => {
    expect(backoffSeconds(1)).toBe(30)
    expect(backoffSeconds(2)).toBe(60)
    expect(backoffSeconds(3)).toBe(120)
  })

  it('is capped, so an outage is not a tight loop nor an eternity', () => {
    expect(backoffSeconds(99)).toBe(6 * 60 * 60)
  })

  it('gives up after MAX_ATTEMPTS and leaves it for a human', () => {
    expect(shouldGiveUp(MAX_ATTEMPTS - 1)).toBe(false)
    expect(shouldGiveUp(MAX_ATTEMPTS)).toBe(true)
  })
})
