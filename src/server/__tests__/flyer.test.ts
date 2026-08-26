import { describe, expect, it } from 'vitest'
import { escapeHtml, flyerCard, renderFlyerSheet, shareUrl } from '@/server/flyerService'

const base = {
  businessName: "Jake's Bin Service",
  serviceName: 'Curb-to-house return',
  price: '$3',
  priceUnit: '/week',
  areaLabel: 'Oak Ridge',
  storefrontUrl: 'https://countonlocal.com/jakes-bin-service',
}

describe('escaping, because this becomes a printed document', () => {
  it('escapes the five characters that matter', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;')
  })

  it('escapes an ampersand before anything else, so entities are not doubled', () => {
    expect(escapeHtml('Tom & Jerry <b>')).toBe('Tom &amp; Jerry &lt;b&gt;')
  })

  it('neutralises a script tag in a business name', () => {
    const html = flyerCard({ ...base, businessName: '<script>alert(1)</script>' })
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('neutralises markup in a provider-written headline', () => {
    const html = flyerCard({ ...base, headline: '<img src=x onerror=alert(1)>' })
    expect(html).not.toContain('<img src=x')
  })

  it('escapes an apostrophe in an ordinary name without mangling it', () => {
    const html = flyerCard(base)
    expect(html).toContain('Jake&#39;s Bin Service')
  })
})

describe('what a flyer carries', () => {
  it('shows the service, price and business', () => {
    const html = flyerCard(base)
    expect(html).toContain('Curb-to-house return')
    expect(html).toContain('$3')
    expect(html).toContain('/week')
  })

  it('prints the URL as text, not only as a code', () => {
    // A QR is useless to somebody already holding their phone, and useless
    // to any camera that will not focus in the rain.
    const html = flyerCard(base)
    expect(html).toContain('countonlocal.com/jakes-bin-service')
  })

  it('uses the provider headline when they wrote one', () => {
    const html = flyerCard({ ...base, headline: 'Hate bringing the cans back?' })
    expect(html).toContain('Hate bringing the cans back?')
  })

  it('falls back to approved copy when they did not', () => {
    expect(flyerCard(base)).toContain('One less thing to remember')
  })

  it('ignores a whitespace-only headline', () => {
    expect(flyerCard({ ...base, headline: '   ' })).toContain('One less thing to remember')
  })
})

describe('a flyer never carries customer data', () => {
  it('says nothing about customer count below the privacy threshold', () => {
    const html = flyerCard({ ...base, activeCustomers: 2 })
    expect(html).not.toMatch(/Serving \d+ homes/)
    // Not a hedge either.
    expect(html).not.toMatch(/a few homes|popular/i)
  })

  it('may say how many once the threshold is met', () => {
    const html = flyerCard({ ...base, activeCustomers: 8 })
    expect(html).toContain('Serving 8 homes in Oak Ridge')
  })

  it('says nothing when the count was not supplied at all', () => {
    expect(flyerCard(base)).not.toMatch(/Serving \d+ homes/)
  })

  it('never contains a street address', () => {
    const html = flyerCard({ ...base, activeCustomers: 8 })
    expect(html).not.toMatch(/\d+\s+\w+\s+(St|Street|Ave|Avenue|Rd|Road|Lane)\b/i)
  })
})

describe('the QR slot', () => {
  it('says plainly when no code was generated', () => {
    const html = flyerCard(base)
    // Not a decorative square somebody might print thinking it works.
    expect(html).toContain('not generated')
    expect(html).toContain('qr-missing')
  })

  it('renders an image when one is supplied', () => {
    const html = flyerCard({ ...base, qrDataUri: 'data:image/png;base64,iVBORw0KGgo=' })
    expect(html).toContain('<img class="qr"')
    expect(html).not.toContain('qr-missing')
  })

  it('escapes the data URI rather than trusting it', () => {
    const html = flyerCard({ ...base, qrDataUri: 'data:image/png;base64,x" onerror="alert(1)' })
    expect(html).not.toContain('onerror="alert(1)"')
  })

  it('gives the image alt text naming the business', () => {
    const html = flyerCard({ ...base, qrDataUri: 'data:image/png;base64,iVBORw0KGgo=' })
    expect(html).toContain('alt="Scan to open Jake&#39;s Bin Service"')
  })
})

describe('the printable sheet', () => {
  it('is a complete document', () => {
    const html = renderFlyerSheet(base)
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('@page')
  })

  it('repeats the flyer so one sheet is worth printing', () => {
    const html = renderFlyerSheet(base, 4)
    expect(html.split('class="flyer"').length - 1).toBe(4)
  })

  it('refuses to print nothing', () => {
    expect(renderFlyerSheet(base, 0).split('class="flyer"').length - 1).toBe(1)
  })

  it('caps the copies rather than generating a hundred pages', () => {
    expect(renderFlyerSheet(base, 500).split('class="flyer"').length - 1).toBe(8)
  })

  it('escapes the business name in the document title too', () => {
    const html = renderFlyerSheet({ ...base, businessName: '<script>x</script>' })
    expect(html).not.toContain('<title><script>')
  })
})

describe('share links', () => {
  it('is just the storefront with no referral code', () => {
    expect(shareUrl({ storefrontUrl: base.storefrontUrl })).toBe(base.storefrontUrl)
  })

  it('carries the code as a parameter, so a stripped link still works', () => {
    const url = shareUrl({ storefrontUrl: base.storefrontUrl, referralCode: 'ABCD2345' })
    expect(url).toBe('https://countonlocal.com/jakes-bin-service?ref=ABCD2345')
  })

  it('does not double up an existing parameter', () => {
    const url = shareUrl({
      storefrontUrl: 'https://countonlocal.com/x?ref=OLD',
      referralCode: 'NEW23456',
    })
    expect(url).toBe('https://countonlocal.com/x?ref=NEW23456')
  })
})
