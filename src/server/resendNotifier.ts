/**
 * Sending email through Resend.
 *
 * Implements the Notifier interface from notifications.ts, so everything
 * above it -- the outbox, the claim, the backoff, the give-up rule -- is
 * unchanged and still exercisable against StubNotifier without a network.
 *
 * ## No SDK
 *
 * One authenticated POST. Adding a dependency to spell that differently
 * would be a package to audit, update and trust for no capability we do not
 * already have, and CLAUDE.md asks for the owner's go-ahead on new
 * dependencies precisely so they do not accumulate for convenience.
 *
 * ## The email is a doorbell, not a letter
 *
 * The body carries a sentence and a link, and never the thing itself.
 * TECHNICAL_SPEC section 17 and SAFETY_TRUST_POLICY section 14 keep
 * addresses, gate codes and schedules out of previews -- but the deeper
 * reason is that email is not an authenticated channel. It sits in an inbox
 * on a shared family tablet, it is forwarded, it is read on a lock screen.
 * Anything that matters is behind a sign-in, which is why a draft's payload
 * is ids rather than content.
 *
 * checkDraft already refuses a draft whose subject or preview leaks; this
 * is the second half of that promise, which is that the body cannot leak
 * either because it is never given anything to leak.
 */

import type { Notifier, SendRequest, SendResult } from '@/server/notifications'

const ENDPOINT = 'https://api.resend.com/emails'

export type ResendConfig = {
  apiKey: string
  /** Must be an address at a domain verified with Resend. */
  fromEmail: string
  /** Where a link in the body points. No trailing slash. */
  appUrl: string
}

/**
 * Reads configuration, or explains what is missing.
 *
 * Returns rather than throws: an unconfigured sender must leave the
 * UnconfiguredNotifier in place, which refuses loudly, rather than taking
 * the process down at import time.
 */
export function resendConfigFromEnv(env: Record<string, string | undefined>): ResendConfig | null {
  const apiKey = env['NOTIFICATIONS_PROVIDER_API_KEY']?.trim()
  const fromEmail = env['NOTIFICATIONS_FROM_EMAIL']?.trim()
  if (!apiKey || !fromEmail) return null

  return {
    apiKey,
    fromEmail,
    appUrl: (env['NEXT_PUBLIC_APP_URL']?.trim() || 'https://countonlocal.com').replace(/\/+$/, ''),
  }
}

export class ResendNotifier implements Notifier {
  constructor(private readonly config: ResendConfig) {}

  async send(request: SendRequest): Promise<SendResult> {
    if (request.channel !== 'email') {
      // SMS and push have no provider. Permanent rather than retryable:
      // trying again in four minutes will not grow one.
      return {
        ok: false,
        retryable: false,
        message: `No provider configured for ${request.channel}.`,
      }
    }

    const { subject, text, html } = renderEmail(request, this.config.appUrl)

    let response: Response
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
          // Keyed on the outbox row, which is unique per queued message.
          //
          // It was previously derived from kind, destination and subject,
          // which is the same string for two different guardian
          // invitations to the same address -- while their bodies carry
          // different tokens. Resend answers that with a 409
          // invalid_idempotent_request, which this classified as permanent,
          // so the second invitation was marked dead and silently dropped.
          // A resent invitation is exactly the case the feature exists for.
          //
          // The row id is stable across retries of the same row, so a retry
          // after a timeout is still a no-op on the provider's side, which
          // is what the header is for.
          'Idempotency-Key': `notification:${request.id}`,
        },
        body: JSON.stringify({
          from: this.config.fromEmail,
          to: [request.destination],
          subject,
          text,
          html,
        }),
      })
    } catch (error) {
      // Unreachable, DNS, timeout. Worth trying again.
      return {
        ok: false,
        retryable: true,
        message: error instanceof Error ? error.message : 'Could not reach the email provider.',
      }
    }

    if (response.ok) {
      const body = (await response.json().catch(() => ({}))) as { id?: string }
      return body.id ? { ok: true, providerMessageId: body.id } : { ok: true }
    }

    const detail = await response.text().catch(() => '')

    // 429 and 5xx are the provider having a moment. Everything else in the
    // 4xx range is this request being wrong -- a malformed address, an
    // unverified sending domain, a revoked key -- and retrying it six times
    // with backoff only delays somebody noticing.
    const retryable = response.status === 429 || response.status >= 500

    return {
      ok: false,
      retryable,
      message: `Resend returned ${response.status}${detail ? `: ${truncate(detail)}` : ''}`,
    }
  }
}

function truncate(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat
}

export type RenderedEmail = { subject: string; text: string; html: string }

/**
 * Turns an outbox row into an email.
 *
 * Uses only the subject and preview the draft already carries -- both of
 * which checkDraft has vetted -- plus a link. The payload is deliberately
 * not rendered: it holds ids, and resolving them here would mean putting
 * the resolved values in an email, which is the thing this design exists to
 * avoid.
 *
 * The one exception is a token-bearing path, because an invitation that
 * does not carry its own link is not an invitation. A guardian has no
 * account yet and cannot be asked to sign in first.
 */
export function renderEmail(request: SendRequest, appUrl: string): RenderedEmail {
  const subject = request.subject?.trim() || defaultSubject(request.kind)
  const preview = request.preview?.trim() || 'There is an update waiting for you.'

  const path = linkPath(request)
  const link = `${appUrl}${path}`

  const text = [preview, '', link, '', 'Count On Local'].join('\n')

  const html = [
    '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:16px;line-height:1.55;color:#14263A">',
    `<p>${escapeHtml(preview)}</p>`,
    `<p><a href="${escapeHtml(link)}" style="display:inline-block;background:#14263A;color:#fff;padding:12px 18px;border-radius:12px;text-decoration:none;font-weight:700">Open Count On Local</a></p>`,
    `<p style="color:#607080;font-size:13px">If the button does not work, paste this into your browser:<br>${escapeHtml(link)}</p>`,
    '</div>',
  ].join('')

  return { subject, text, html }
}

/**
 * Where the link goes.
 *
 * A guardian invitation carries its token because the recipient has no
 * account to sign in to. Everything else points at the signed-in area and
 * lets authentication decide what may be shown -- a link that reveals
 * something without a sign-in is a link anybody who sees the inbox can use.
 */
function linkPath(request: SendRequest): string {
  const token = request.payload['invitationToken']
  if (request.kind === 'guardian.approval_requested' && typeof token === 'string' && token) {
    return `/guardian/invitations/${encodeURIComponent(token)}`
  }
  return '/account'
}

function defaultSubject(kind: string): string {
  switch (kind) {
    case 'guardian.approval_requested':
      return 'Someone needs your approval'
    case 'guardian.approved':
      return 'Your guardian approved your account'
    case 'guardian.revoked':
      return 'A guardian approval was withdrawn'
    case 'subscription.payment_failed':
      return 'A payment did not go through'
    case 'safety.alert':
      return 'Something needs your attention'
    default:
      return 'An update from Count On Local'
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
