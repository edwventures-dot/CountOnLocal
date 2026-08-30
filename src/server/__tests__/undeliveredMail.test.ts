import { describe, expect, it } from 'vitest'
import { destinationDomain } from '@/server/undeliveredMail'

describe('what staff are shown instead of the address', () => {
  it('keeps the domain, which is what tells a typo from an outage', () => {
    // "invalid to field" on gmial.com is a different problem from a 500,
    // and the domain is the whole of the diagnosis.
    expect(destinationDomain('someone@gmial.com')).toBe('gmial.com')
    expect(destinationDomain('a.person+tag@Example.CO.UK')).toBe('example.co.uk')
  })

  it('drops the person, so the console is not a directory', () => {
    for (const address of ['jo@oakridge.test', 'a.very.identifying.name@x.com']) {
      const shown = destinationDomain(address)
      expect(shown).not.toContain('@')
      expect(address.startsWith(shown)).toBe(false)
    }
  })

  it('does not print junk that is not an address at all', () => {
    // A malformed destination is exactly the row worth surfacing, and
    // echoing whatever is in that column onto a screen is not the way.
    for (const junk of ['', 'not-an-address', 'trailing@', '@leading']) {
      const shown = destinationDomain(junk)
      expect(shown === '(not an address)' || shown === 'leading').toBe(true)
    }
  })
})
