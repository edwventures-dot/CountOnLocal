import { describe, expect, it } from 'vitest'
import {
  ALLOWED_PROPERTIES,
  ANALYTICS_EVENTS,
  buildEvent,
  isAnalyticsEvent,
  postalPrefix,
  scrubProperties,
} from '../analytics'

describe('the events are exactly the defined funnel', () => {
  it('recognises what PRD 25 lists', () => {
    expect(isAnalyticsEvent('subscription_started')).toBe(true)
    expect(isAnalyticsEvent('referral_converted')).toBe(true)
  })

  it('refuses anything invented', () => {
    // An events table that accumulates whatever anybody fired stops being
    // answerable to a question.
    expect(isAnalyticsEvent('button_clicked')).toBe(false)
    expect(isAnalyticsEvent('')).toBe(false)
    expect(isAnalyticsEvent(null)).toBe(false)
  })

  it('has no duplicates', () => {
    expect(new Set(ANALYTICS_EVENTS).size).toBe(ANALYTICS_EVENTS.length)
  })

  it('refuses to build an unknown one, and says where to add it', () => {
    const r = buildEvent({ event: 'vibes_measured' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('PRD section 25')
  })
})

describe('everything TECHNICAL_SPEC 17 forbids is dropped', () => {
  it.each([
    ['full customer address', { line1: '742 Evergreen Terrace' }],
    ['address under another name', { address: '742 Evergreen Terrace' }],
    ['date of birth', { date_of_birth: '2011-04-02' }],
    ['dob abbreviation', { dob: '2011-04-02' }],
    ['gate code', { access_notes: 'Gate code 4417' }],
    ['gate code under another name', { gate_code: '4417' }],
    ['message body', { message_body: 'see you tuesday' }],
    ['photo url', { photo_url: 'https://storage/abc.jpg' }],
    ['payment method', { payment_method: 'pm_1234' }],
    ['card details', { card_last4: '4242' }],
    ['email', { email: 'jake@example.com' }],
    ['phone', { phone: '512-555-0199' }],
    ['guardian identity', { guardian_ssn: '000-00-0000' }],
    ['full postal code', { postal_code: '78701' }],
  ])('drops %s', (_label, payload) => {
    const r = scrubProperties(payload)
    expect(Object.keys(r.properties)).toHaveLength(0)
    expect(r.dropped.length).toBe(1)
  })

  it('survives somebody spreading a whole subscription into a payload', () => {
    // The realistic failure: not a developer typing `gate_code`, but
    // `...subscription` putting forty fields into a vendor's database.
    const r = scrubProperties({
      id: 'sub_1',
      subscription_id: 'sub_1',
      customer_user_id: 'u_1',
      line1: '742 Evergreen Terrace',
      city: 'Austin',
      postal_code: '78701',
      access_notes: 'Gate code 4417',
      stripe_payment_method_id: 'pm_123',
      provider_price_cents: 300,
      price_cents: 300,
      date_of_birth: '2011-04-02',
    })

    expect(r.properties).toEqual({ subscription_id: 'sub_1', price_cents: 300 })
    const serialized = JSON.stringify(r.properties)
    expect(serialized).not.toContain('Evergreen')
    expect(serialized).not.toContain('4417')
    expect(serialized).not.toContain('78701')
    expect(serialized).not.toContain('2011')
  })

  it('keeps the dropped names so a developer sees what happened', () => {
    const r = scrubProperties({ line1: 'x', subscription_id: 'sub_1' })
    expect(r.dropped).toContain('line1')
  })
})

describe('the allowlist is the mechanism', () => {
  it('drops an unknown key even when its value looks harmless', () => {
    // A denylist protects against fields somebody thought of.
    const r = scrubProperties({ some_new_dimension: 'blue' })
    expect(r.properties).toEqual({})
    expect(r.dropped).toEqual(['some_new_dimension'])
  })

  it('allows opaque identifiers', () => {
    const r = scrubProperties({ subscription_id: 'sub_1', business_id: 'biz_1' })
    expect(Object.keys(r.properties).sort()).toEqual(['business_id', 'subscription_id'])
  })

  it('allows counts, money and booleans', () => {
    const r = scrubProperties({
      price_cents: 300,
      occurrence_count: 4,
      eligible: true,
      at_capacity: false,
    })
    expect(Object.keys(r.properties)).toHaveLength(4)
  })

  it('allows null, which is a real answer', () => {
    const r = scrubProperties({ reason_code: null })
    expect(r.properties['reason_code']).toBeNull()
  })

  it('contains no property that is obviously personal', () => {
    for (const key of ALLOWED_PROPERTIES) {
      expect(key).not.toMatch(/email|phone|address|line1|line2|dob|birth|ssn|card|token|body|notes/i)
    }
  })

  it('has no full postal code, only a prefix', () => {
    expect(ALLOWED_PROPERTIES.has('postal_code')).toBe(false)
    expect(ALLOWED_PROPERTIES.has('postal_prefix')).toBe(true)
  })
})

describe('free text cannot sneak through an allowed key', () => {
  it('drops a long string in an allowed field', () => {
    // An allowed key holding an essay is a payload somebody put free text
    // into. Truncating would send half an address; dropping sends none.
    const r = scrubProperties({ reason_code: 'x'.repeat(200) })
    expect(r.properties).toEqual({})
    expect(r.dropped).toContain('reason_code')
  })

  it('keeps a short enumeration value', () => {
    const r = scrubProperties({ reason_code: 'customer_inside_cutoff' })
    expect(r.properties['reason_code']).toBe('customer_inside_cutoff')
  })

  it('drops a nested object rather than walking it', () => {
    // Walking one would mean deciding what address.city is called in the
    // allowlist, which is how an address ends up half-allowed.
    const r = scrubProperties({ subscription_id: { nested: 'value' } })
    expect(r.properties).toEqual({})
  })

  it('drops an array too', () => {
    const r = scrubProperties({ occurrence_id: ['a', 'b'] })
    expect(r.properties).toEqual({})
  })

  it('drops undefined rather than sending it', () => {
    const r = scrubProperties({ price_cents: undefined })
    expect(r.properties).toEqual({})
  })
})

describe('coarse geography', () => {
  it('keeps three digits of a ZIP', () => {
    expect(postalPrefix('78701')).toBe('787')
  })

  it('handles ZIP+4', () => {
    expect(postalPrefix('78701-1234')).toBe('787')
  })

  it('returns nothing for something that is not a postal code', () => {
    expect(postalPrefix('abc')).toBeNull()
    expect(postalPrefix('123')).toBeNull()
  })

  it('never returns enough to find a household', () => {
    // Five digits is a few thousand homes; three is a chunk of a state.
    expect(postalPrefix('78701')).toHaveLength(3)
  })
})

describe('buildEvent', () => {
  it('assembles a clean envelope', () => {
    const r = buildEvent({
      event: 'subscription_started',
      properties: { subscription_id: 'sub_1', price_cents: 300 },
      userId: 'u_1',
    })

    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.envelope.event).toBe('subscription_started')
      expect(r.envelope.userId).toBe('u_1')
      expect(r.envelope.properties).toEqual({ subscription_id: 'sub_1', price_cents: 300 })
    }
  })

  it('scrubs while it builds, and reports what went', () => {
    const r = buildEvent({
      event: 'address_checked',
      properties: { line1: '742 Evergreen Terrace', eligible: true },
    })

    if (r.ok) {
      expect(r.envelope.properties).toEqual({ eligible: true })
      expect(r.dropped).toContain('line1')
    }
  })

  it('works with no properties at all', () => {
    const r = buildEvent({ event: 'age_gate_passed' })
    if (r.ok) expect(r.envelope.properties).toEqual({})
  })

  it('omits the user id rather than sending an empty one', () => {
    const r = buildEvent({ event: 'age_gate_passed', userId: '' })
    if (r.ok) expect(r.envelope.userId).toBeUndefined()
  })
})
