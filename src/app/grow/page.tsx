import Link from 'next/link'
import { redirect } from 'next/navigation'
import { authenticate } from '@/server/auth'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { getGrowDashboard } from '@/server/growService'
import { qrSvgDataUri } from '@/server/qr'
import { SignOutButton } from '@/components/SignOutButton'
import { CopyLink } from '@/components/CopyLink'
import { Alert, Card, Shell, Stack } from '@/components/ui'

export const metadata = { title: 'Get more customers | Count On Local' }
export const dynamic = 'force-dynamic'

/**
 * The share and growth screen.
 *
 * ## What this closes
 *
 * getGrowDashboard, the density rules, the growth prompts, the QR encoder
 * and the printable flyer sheet were all built and tested, and none of them
 * had a page. A provider could not get their own link, their own QR code,
 * or their own flyer. This is the last of the audit that found messaging
 * and reviews in the same state.
 *
 * ## Server-rendered, including the QR
 *
 * qrSvgDataUri runs here and the result goes into an img src. There is no
 * reason to ship a QR library to a phone to draw a code the server already
 * knows how to draw, and the only interactive thing on the page is the
 * copy-to-clipboard button.
 *
 * ## One prompt, not a list
 *
 * growthPrompt returns exactly one suggestion. A grow screen with five
 * suggestions is a screen nobody acts on, and the domain has already
 * decided which one matters most for this route today.
 */
export default async function GrowPage() {
  const auth = await authenticate()
  if (!auth.ok) redirect('/signin?next=%2Fgrow')

  const db = await createSupabaseServerClient()
  const result = await getGrowDashboard({ db, providerUserId: auth.auth.userId })

  if (!result.ok) {
    return (
      <Shell nav={<SignOutButton />} narrow>
        <h1>Get more customers</h1>
        <Card>
          <p className="muted">{result.message}</p>
          <Link className="btn" href="/business">
            Your business
          </Link>
        </Card>
      </Shell>
    )
  }

  const { dashboard } = result

  // The share URL rather than the bare storefront, so a scan is attributed
  // to this provider's referral code. Failure is not fatal: the link is
  // printed beside it and a page without a QR still works.
  const qr = await qrSvgDataUri(dashboard.shareUrl)

  return (
    <Shell nav={<SignOutButton />} narrow>
      <h1>Get more customers</h1>
      <p className="muted">{dashboard.businessName}</p>

      <Stack>
        <Card>
          <h2>Your link</h2>
          <p className="muted small">
            Anyone with this can see your page and check whether you cover their address. Share it
            with people you and your family already know.
          </p>
          <CopyLink url={dashboard.shareUrl} />
          {dashboard.referralCode ? (
            <p className="small muted">
              It carries your referral code, so a signup that starts here is credited to you.
            </p>
          ) : null}
        </Card>

        <Card>
          <h2>Your QR code</h2>
          {qr.ok ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                className="qr"
                src={qr.dataUri}
                alt={`QR code linking to ${dashboard.shareUrl}`}
                width={200}
                height={200}
              />
              <p className="small muted">
                Point a phone camera at it. Right-click or long-press to save the image.
              </p>
            </>
          ) : (
            <Alert kind="error">
              We could not draw the code right now. Your link above still works.
            </Alert>
          )}
        </Card>

        <Card>
          <h2>Printable flyers</h2>
          <p className="muted small">
            Four to a sheet, with the QR code on each. It opens ready to print. Nothing on it says
            who already subscribes.
          </p>
          {dashboard.services.length === 0 ? (
            <p className="small muted">Add a service first and the flyer will have something to say.</p>
          ) : (
            <ul className="list">
              {dashboard.services.map((s) => (
                <li key={s.serviceId} className="list__item">
                  <span>{s.publicName}</span>
                  {/* A new tab: this returns a printable document, not a
                      page in the app, and losing the dashboard behind it
                      would be a surprise. */}
                  <a
                    className="btn btn--secondary"
                    href={`/api/v1/provider/flyer?serviceId=${encodeURIComponent(s.serviceId)}&copies=4`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open flyer
                  </a>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {dashboard.services.map((s) => (
          <Card key={s.serviceId}>
            <h2>{s.publicName}</h2>

            <p className="small muted">
              {s.density.activeCustomers} of {s.density.capacity} spots taken
              {s.density.openSpots > 0 ? ` · ${s.density.openSpots} open` : ' · full'}
            </p>

            <div className="meter" aria-hidden="true">
              <div
                className="meter__fill"
                style={{ width: `${Math.round(s.density.utilization * 100)}%` }}
              />
            </div>

            <h3 className="small">{s.prompt.headline}</h3>
            <p className="small">{s.prompt.detail}</p>

            {/* The domain says which action fits this route today. */}
            {s.prompt.action === 'flyer' ? (
              <a
                className="btn"
                href={`/api/v1/provider/flyer?serviceId=${encodeURIComponent(s.serviceId)}&copies=4`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Print flyers
              </a>
            ) : s.prompt.action === 'expand_area' || s.prompt.action === 'set_capacity' ? (
              <Link className="btn" href="/business">
                {s.prompt.action === 'set_capacity' ? 'Set how many houses' : 'Widen your area'}
              </Link>
            ) : null}

            <dl className="stats">
              <div>
                <dt>A full cycle is worth</dt>
                <dd>${(s.routeValueCents / 100).toFixed(2)}</dd>
              </div>
              {s.earningsPerHourCents !== null ? (
                <div>
                  <dt>Roughly per hour</dt>
                  <dd>${(s.earningsPerHourCents / 100).toFixed(2)}</dd>
                </div>
              ) : null}
            </dl>
            {s.earningsPerHourCents === null ? (
              <p className="small muted">
                Not enough visits yet to work out an hourly figure. A confident number from one stop
                would be a guess.
              </p>
            ) : null}
          </Card>
        ))}
      </Stack>
    </Shell>
  )
}
