import { describe, expect, it } from 'vitest'
import {
  checkLength,
  checkMessage,
  MAX_MESSAGE_LENGTH,
  retentionDaysFor,
  RETENTION_DAYS_FLAGGED,
  RETENTION_DAYS_ORDINARY,
} from '../messaging'

const adults = { involvesMinor: false }
const withMinor = { involvesMinor: true }

const allow = (body: string, ctx = adults) => checkMessage(body, ctx).verdict === 'allow'

/**
 * The most important block in this file.
 *
 * A messaging system that refuses ordinary sentences is one people route
 * around by texting, which loses every safety property it was built for.
 * These are the messages a real bin round actually produces.
 */
describe('ordinary conversation goes through', () => {
  it.each([
    'I will be there around 8 on Tuesday.',
    'The side gate was locked so I left them by the porch.',
    'Running about 20 minutes late today, sorry!',
    'Can you do 5 dollars instead? Bins are heavy on collection week.',
    'Your total is $13.80 for the next 4 weeks.',
    '18 of 18 stops done today.',
    'Thanks! See you next Tuesday.',
    'No service on the 25th, I am away that week.',
    'Which bin do you want brought back, the green one or both?',
    'I am at number 42 now, be with you in a minute.',
    'That weather this morning was killing me.',
    'I killed it today, whole route done by 9.',
    'We paid the window cleaner in cash last week but not you obviously',
    'Left them by the cash machine end of the drive',
    'The dog was out so I did not go in the back garden.',
    'Happy to do an extra bin for a bit more per week.',
  ])('allows: %s', (body) => {
    expect(allow(body)).toBe(true)
  })

  it('allows a date and a time in the same message', () => {
    expect(allow('Tuesday 9/15 between 8:00 and 18:00')).toBe(true)
  })

  it('allows a price negotiation, which belongs on the platform', () => {
    expect(allow('Would $4 a week work if I take both bins?')).toBe(true)
  })
})

describe('phone numbers are blocked', () => {
  it.each([
    'Call me on 555-0123456',
    'my number is (512) 555-0199',
    'text 5125550199 instead',
    'reach me at +1 512 555 0199',
  ])('blocks: %s', (body) => {
    const r = checkMessage(body, adults)
    expect(r.verdict).toBe('block')
    if (r.verdict === 'block') expect(r.code).toBe('phone_number')
  })

  it('blocks digits spelled out to dodge the check', () => {
    const r = checkMessage('five one two five five five zero one nine nine', adults)
    expect(r.verdict).toBe('block')
  })

  it('explains why rather than citing terms', () => {
    const r = checkMessage('call me on 512-555-0199', adults)
    if (r.verdict === 'block') {
      expect(r.message).toMatch(/report button|guardian/i)
      // Never quotes what was matched back at the sender.
      expect(r.message).not.toContain('555')
    }
  })
})

describe('email addresses and social handles are blocked', () => {
  it.each([
    'email me at jake@example.com',
    'jake (at) example (dot) com',
    'find me on instagram, my handle is jakesbins',
    'add me on snapchat',
    'dm me',
  ])('blocks: %s', (body) => {
    expect(checkMessage(body, adults).verdict).toBe('block')
  })
})

describe('payment circumvention is blocked', () => {
  it.each([
    'just venmo me',
    'do you have Cash App?',
    'send it on zelle',
    'my cashtag is $jakesbins',
    'can you pay in cash instead',
    'cash only from now on',
    'easier if you pay me directly',
    'we can do this off the app',
  ])('blocks: %s', (body) => {
    const r = checkMessage(body, adults)
    expect(r.verdict).toBe('block')
    if (r.verdict === 'block') {
      expect(['payment_app', 'off_platform_payment']).toContain(r.code)
    }
  })

  it('does not mistake a price for a cashtag', () => {
    expect(allow('It comes to $13.80 this cycle')).toBe(true)
    expect(allow('$3/week')).toBe(true)
  })

  it('explains that payments are recorded and protected', () => {
    const r = checkMessage('just venmo me', adults)
    if (r.verdict === 'block') expect(r.message).toMatch(/recorded|protected/i)
  })
})

describe('threats are blocked and escalated', () => {
  it.each([
    'I will find you',
    "i'm going to hurt you",
    'watch your back',
    'i know where you live',
  ])('blocks: %s', (body) => {
    const r = checkMessage(body, adults)
    expect(r.verdict).toBe('block')
    if (r.verdict === 'block') {
      expect(r.code).toBe('threat')
      expect(r.urgent).toBe(true)
    }
  })

  it('does not deliver and flag -- the child not reading it is the point', () => {
    const r = checkMessage('i will hurt you', withMinor)
    expect(r.verdict).toBe('block')
  })

  it('tells the sender it was reported, without arguing', () => {
    const r = checkMessage('i know where you live', adults)
    if (r.verdict === 'block') expect(r.message).toContain('reported')
  })

  it('does not trip on violent words used ordinarily', () => {
    expect(allow('that hill is going to kill me')).toBe(true)
    expect(allow('the wind killed my bin lid')).toBe(true)
  })
})

describe('sexual content is blocked and escalated', () => {
  it('blocks and marks urgent', () => {
    const r = checkMessage('send pics', adults)
    expect(r.verdict).toBe('block')
    if (r.verdict === 'block') {
      expect(r.code).toBe('sexual_content')
      expect(r.urgent).toBe(true)
    }
  })
})

describe('prohibited work cannot be arranged in a message either', () => {
  it.each([
    'could you watch my kids on Thursday',
    'any chance you could babysit',
    'need someone to house sit next week',
    'can you get the leaves off the roof',
    'bring a ladder and do the gutters',
    'come clean inside the house',
    'can you drive me to the shops',
  ])('blocks: %s', (body) => {
    const r = checkMessage(body, adults)
    expect(r.verdict).toBe('block')
    if (r.verdict === 'block') expect(r.code).toBe('prohibited_work')
  })

  it('says the work is not covered rather than accusing anybody', () => {
    const r = checkMessage('could you babysit on Friday', adults)
    // Most people asking this are being friendly, not malicious.
    if (r.verdict === 'block') {
      expect(r.message).toMatch(/not something Count On Local covers/i)
      expect(r.message).not.toMatch(/reported|violation/i)
    }
  })

  it('escalates it when a minor is in the thread', () => {
    const adult = checkMessage('can you babysit', adults)
    const minor = checkMessage('can you babysit', withMinor)
    if (adult.verdict === 'block' && minor.verdict === 'block') {
      expect(adult.urgent).toBe(false)
      expect(minor.urgent).toBe(true)
    }
  })
})

describe('the safety rule wins when a message trips two', () => {
  it('reports a threat rather than the phone number beside it', () => {
    const r = checkMessage('i will find you, call 512-555-0199', adults)
    if (r.verdict === 'block') {
      expect(r.code).toBe('threat')
      expect(r.urgent).toBe(true)
    }
  })
})

describe('one reason at a time', () => {
  it('does not list everything wrong, which reads as a checklist to beat', () => {
    const r = checkMessage('venmo me at jake@example.com or call 512-555-0199', adults)
    expect(r.verdict).toBe('block')
    if (r.verdict === 'block') {
      expect(typeof r.code).toBe('string')
      expect(r.message.split('.').length).toBeLessThan(6)
    }
  })
})

describe('length', () => {
  it('accepts an ordinary message', () => {
    const r = checkLength('  See you Tuesday.  ')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.body).toBe('See you Tuesday.')
  })

  it('refuses an empty one', () => {
    expect(checkLength('   ').ok).toBe(false)
  })

  it('refuses an over-long one', () => {
    expect(checkLength('x'.repeat(MAX_MESSAGE_LENGTH + 1)).ok).toBe(false)
  })

  it('blocks an empty body at the content check too', () => {
    expect(checkMessage('   ', adults).verdict).toBe('block')
  })
})

describe('retention', () => {
  it('keeps ordinary conversation for a year', () => {
    expect(retentionDaysFor({ flagged: false })).toBe(RETENTION_DAYS_ORDINARY)
  })

  it('keeps flagged messages far longer, because they are evidence', () => {
    expect(retentionDaysFor({ flagged: true })).toBe(RETENTION_DAYS_FLAGGED)
    expect(RETENTION_DAYS_FLAGGED).toBeGreaterThan(RETENTION_DAYS_ORDINARY)
  })

  it('does not keep anything forever', () => {
    // TECHNICAL_SPEC 23 warns against inventing indefinite retention.
    expect(RETENTION_DAYS_FLAGGED).toBeLessThan(365 * 10)
  })
})
