import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderEmail, ResendNotifier, resendConfigFromEnv } from '../resendNotifier'
import type { ResendConfig } from '../resendNotifier'
import type { SendRequest } from '../notifications'

const CONFIG: ResendConfig = {
  apiKey: 'test-key',
  fromEmail: 'Count On Local <hello@countonlocal.com>',
  appUrl: 'https://countonlocal.com',
}

function request(over: Partial<SendRequest> = {}): SendRequest {
  return {
    channel: 'email',
    destination: 'guardian@example.com',
    subject: 'Someone needs your approval',
    preview: 'Jordan asked you to approve their service.',
    kind: 'guardian.approval_requested',
    payload: {},
    ...over,
  }
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const ok = (body: unknown = { id: 'msg_1' }) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

describe('sending', () => {
  it('posts to Resend and returns the provider id', async () => {
    fetchMock.mockResolvedValue(ok())
    const r = await new ResendNotifier(CONFIG).send(request())

    expect(r).toEqual({ ok: true, providerMessageId: 'msg_1' })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.resend.com/emails')
    expect(init.headers.Authorization).toBe('Bearer test-key')
  })

  it('succeeds even when the provider returns no id', async () => {
    fetchMock.mockResolvedValue(ok({}))
    expect(await new ResendNotifier(CONFIG).send(request())).toEqual({ ok: true })
  })

  it('sends from the configured address to the destination only', async () => {
    fetchMock.mockResolvedValue(ok())
    await new ResendNotifier(CONFIG).send(request())

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body)
    expect(body.from).toBe(CONFIG.fromEmail)
    expect(body.to).toEqual(['guardian@example.com'])
  })
})

describe('what counts as worth retrying', () => {
  it('retries a rate limit', async () => {
    fetchMock.mockResolvedValue(new Response('slow down', { status: 429 }))
    const r = await new ResendNotifier(CONFIG).send(request())
    expect(r).toMatchObject({ ok: false, retryable: true })
  })

  it('retries a provider outage', async () => {
    fetchMock.mockResolvedValue(new Response('oops', { status: 503 }))
    expect(await new ResendNotifier(CONFIG).send(request())).toMatchObject({ retryable: true })
  })

  it('retries an unreachable network', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'))
    const r = await new ResendNotifier(CONFIG).send(request())
    expect(r).toMatchObject({ ok: false, retryable: true, message: 'ECONNRESET' })
  })

  it('does not retry a bad request', async () => {
    // An unverified sending domain or a malformed address. Six retries with
    // backoff only delay somebody noticing.
    fetchMock.mockResolvedValue(new Response('domain not verified', { status: 403 }))
    expect(await new ResendNotifier(CONFIG).send(request())).toMatchObject({ retryable: false })
  })

  it('does not retry a revoked key', async () => {
    fetchMock.mockResolvedValue(new Response('invalid api key', { status: 401 }))
    expect(await new ResendNotifier(CONFIG).send(request())).toMatchObject({ retryable: false })
  })

  it('says what the provider said, trimmed', async () => {
    fetchMock.mockResolvedValue(new Response('x'.repeat(500), { status: 400 }))
    const r = await new ResendNotifier(CONFIG).send(request())
    if (!r.ok) {
      expect(r.message).toContain('400')
      expect(r.message.length).toBeLessThan(260)
    }
  })

  it('refuses a channel it has no provider for, permanently', async () => {
    const r = await new ResendNotifier(CONFIG).send(request({ channel: 'sms' }))
    // Trying again in four minutes will not grow an SMS provider.
    expect(r).toMatchObject({ ok: false, retryable: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('the email is a doorbell, not a letter', () => {
  it('carries the vetted preview and a link, and nothing else', () => {
    const email = renderEmail(request(), 'https://countonlocal.com')
    expect(email.text).toContain('Jordan asked you to approve their service.')
    expect(email.text).toContain('https://countonlocal.com')
  })

  it('never renders the payload', () => {
    // The payload holds ids. Resolving them here would put the resolved
    // values in an inbox, which is the thing this design exists to avoid.
    const email = renderEmail(
      request({
        payload: {
          subscriptionId: 'sub_1',
          occurrenceId: 'occ_1',
          providerUserId: 'usr_1',
        },
      }),
      'https://countonlocal.com',
    )
    for (const id of ['sub_1', 'occ_1', 'usr_1']) {
      expect(email.text, id).not.toContain(id)
      expect(email.html, id).not.toContain(id)
    }
  })

  it('escapes anything that reaches the html', () => {
    const email = renderEmail(
      request({ preview: 'Jordan & "friends" <script>alert(1)</script>' }),
      'https://countonlocal.com',
    )
    expect(email.html).not.toContain('<script>')
    expect(email.html).toContain('&lt;script&gt;')
    expect(email.html).toContain('&amp;')
  })

  it('sends a guardian to their invitation, because they have no account yet', () => {
    const email = renderEmail(
      request({ payload: { invitationToken: 'tok_abc' } }),
      'https://countonlocal.com',
    )
    expect(email.text).toContain('/guardian/invitations/tok_abc')
  })

  it('sends everybody else behind the sign-in', () => {
    // A link that reveals something without a sign-in is a link anybody who
    // can see the inbox can use.
    const email = renderEmail(
      request({ kind: 'cycle.settled', payload: { subscriptionId: 'sub_1' } }),
      'https://countonlocal.com',
    )
    expect(email.text).toContain('/account')
    expect(email.text).not.toContain('sub_1')
  })

  it('does not follow a token on a kind that is not an invitation', () => {
    // Otherwise any kind could be made to carry a bare-token link by
    // putting the right key in its payload.
    const email = renderEmail(
      request({ kind: 'review.received', payload: { invitationToken: 'tok_abc' } }),
      'https://countonlocal.com',
    )
    expect(email.text).not.toContain('tok_abc')
    expect(email.text).toContain('/account')
  })

  it('falls back to a subject rather than sending an empty one', () => {
    const email = renderEmail(request({ subject: '   ' }), 'https://countonlocal.com')
    expect(email.subject).toBe('Someone needs your approval')
  })
})

describe('configuration', () => {
  it('is null until both the key and the address are set', () => {
    expect(resendConfigFromEnv({})).toBeNull()
    expect(resendConfigFromEnv({ NOTIFICATIONS_PROVIDER_API_KEY: 'k' })).toBeNull()
    expect(resendConfigFromEnv({ NOTIFICATIONS_FROM_EMAIL: 'a@b.com' })).toBeNull()
  })

  it('treats blank as unset, so a placeholder in .env does not look configured', () => {
    expect(
      resendConfigFromEnv({ NOTIFICATIONS_PROVIDER_API_KEY: '  ', NOTIFICATIONS_FROM_EMAIL: '  ' }),
    ).toBeNull()
  })

  it('reads both and trims the app url', () => {
    const config = resendConfigFromEnv({
      NOTIFICATIONS_PROVIDER_API_KEY: 'k',
      NOTIFICATIONS_FROM_EMAIL: 'a@b.com',
      NEXT_PUBLIC_APP_URL: 'https://countonlocal.com///',
    })
    expect(config).toEqual({ apiKey: 'k', fromEmail: 'a@b.com', appUrl: 'https://countonlocal.com' })
  })
})
