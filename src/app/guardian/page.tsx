import Link from 'next/link'
import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { authenticate } from '@/server/auth'
import { PauseBusiness, RevokeApproval } from '@/components/GuardianControls'
import { SignOutButton } from '@/components/SignOutButton'
import { Alert, Card, Shell, Stack } from '@/components/ui'

export const metadata = { title: 'Guardian | Count On Local' }
export const dynamic = 'force-dynamic'

type Dashboard = {
  relationship: { id: string; state: string; provider: { firstName: string | null } }
  business: {
    id: string
    name: string
    slug: string
    state: string
    publicUrl: string
    isLive: boolean
  } | null
  services: Array<{
    id: string
    publicName: string
    priceCents: number
    priceUnit: string
    state: string
    categoryApproved: boolean
    hasServiceArea: boolean
  }>
  upcoming: Array<{
    occurrenceId: string
    serviceDate: string
    state: string
    address: { line1: string; city: string; region: string; postalCode: string } | null
  }>
  activeCustomerCount: number
  payout: { stage: string; canReceivePayments: boolean } | null
  canSeeOperations: boolean
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`

/**
 * What the responsible adult sees.
 *
 * PRD section 6 gives a guardian the right to review services, service
 * areas, scheduled work, incidents and payout status. This is that, and
 * the honest framing is that a guardian who approved an account and then
 * had nothing to look at was being asked to take responsibility without
 * being given oversight.
 *
 * ## Two visibility levels, decided by the server
 *
 * `canSeeOperations` and the null addresses in `upcoming` come from
 * migration 0019: a guardian who has started but is not yet verified can
 * see that work exists, not where it is. Customers gave those addresses to
 * a service, not to the provider's parent, and until the relationship is
 * verified there is nothing establishing who this person is.
 *
 * This page renders what it is given and never fills a gap in with
 * something softer.
 */
export default async function GuardianPage() {
  const auth = await authenticate()
  if (!auth.ok) redirect('/signin?next=%2Fguardian')

  const incoming = await headers()
  const host = incoming.get('host') ?? 'localhost:3000'
  const proto =
    incoming.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https')

  const res = await fetch(`${proto}://${host}/api/v1/guardian/dashboard`, {
    headers: { cookie: incoming.get('cookie') ?? '' },
    cache: 'no-store',
  })

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { code?: string } }

    if (body.error?.code === 'NO_RELATIONSHIP' || res.status === 404 || res.status === 403) {
      return (
        <Shell nav={<SignOutButton />} narrow>
          <h1>Guardian</h1>
          <Alert kind="info">
            You are not the guardian for anyone here. If a young person asked you to approve their
            account, open the link in the email they sent.
          </Alert>
        </Shell>
      )
    }

    return (
      <Shell nav={<SignOutButton />} narrow>
        <h1>Guardian</h1>
        <Alert kind="error">We could not load this just now. Please refresh.</Alert>
      </Shell>
    )
  }

  const d = (await res.json()) as Dashboard
  const name = d.relationship.provider.firstName ?? 'them'
  const verified = d.relationship.state === 'verified'

  return (
    <Shell nav={<SignOutButton />} narrow>
      <h1>{name}&rsquo;s account</h1>
      <p className="muted">{describeRelationship(d.relationship.state, name)}</p>

      <Stack>
        {!verified ? (
          <Alert kind="info">
            {d.relationship.state === 'guardian_started'
              ? `Until your identity is confirmed, ${name} cannot take a paying customer, and addresses stay hidden from this page.`
              : `${name} cannot take a paying customer while this is unresolved.`}
          </Alert>
        ) : null}

        {d.business ? (
          <Card>
            <h2>{d.business.name}</h2>
            <p className="muted small">
              {d.business.isLive ? (
                <>
                  Live at <Link href={`/${d.business.slug}`}>{d.business.publicUrl}</Link>
                </>
              ) : (
                `Not public right now (${d.business.state.replace(/_/g, ' ')})`
              )}
            </p>

            <dl className="ledger">
              <div className="ledger__row">
                <dt>Customers</dt>
                <dd>{d.activeCustomerCount}</dd>
              </div>
              <div className="ledger__row">
                <dt>Getting paid</dt>
                <dd>
                  {d.payout
                    ? d.payout.canReceivePayments
                      ? 'Set up'
                      : describePayout(d.payout.stage)
                    : 'Not started'}
                </dd>
              </div>
            </dl>

            {d.business.isLive ? (
              <PauseBusiness businessId={d.business.id} providerName={name} />
            ) : null}
          </Card>
        ) : (
          <Card>
            <p className="muted" style={{ marginBottom: 0 }}>
              {name} has not built a service page yet.
            </p>
          </Card>
        )}

        {d.services.length > 0 ? (
          <Card>
            <h2>What {name} offers</h2>
            <ul className="list">
              {d.services.map((s) => (
                <li key={s.id} className="list__item">
                  <div>
                    <strong>{s.publicName}</strong>
                    <span className="muted small">
                      {' '}
                      {money(s.priceCents)}/{s.priceUnit}
                    </span>
                    {!s.categoryApproved ? (
                      /*
                        Tier B categories need this guardian to approve the
                        category itself, separately from approving the
                        account. Surfaced because a guardian cannot approve
                        something nobody told them about.
                      */
                      <div className="small" style={{ color: 'var(--col-amber)' }}>
                        Needs your approval for this kind of work
                      </div>
                    ) : null}
                  </div>
                  <span className="small muted">{s.state === 'active' ? 'On' : s.state}</span>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        {d.canSeeOperations ? (
          <Card>
            <h2>Coming up</h2>
            {d.upcoming.length === 0 ? (
              <p className="muted" style={{ marginBottom: 0 }}>
                Nothing scheduled.
              </p>
            ) : (
              <ul className="list">
                {d.upcoming.slice(0, 12).map((v) => (
                  <li key={v.occurrenceId} className="list__item">
                    <span>{v.serviceDate}</span>
                    <span className="small muted">
                      {/*
                        Null until verified, by policy rather than by
                        accident. Saying so is better than an empty cell
                        that reads like a bug.
                      */}
                      {v.address ? `${v.address.line1}, ${v.address.city}` : 'Address hidden'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {d.upcoming.length > 12 ? (
              <p className="small muted">and {d.upcoming.length - 12} more</p>
            ) : null}
          </Card>
        ) : null}

        <Card>
          <h2>Your approval</h2>
          <p className="muted small">
            You can withdraw this at any time. {name} keeps their account and their drafts, but
            cannot take money from anyone.
          </p>
          <RevokeApproval relationshipId={d.relationship.id} providerName={name} />
        </Card>
      </Stack>
    </Shell>
  )
}

function describeRelationship(state: string, name: string): string {
  switch (state) {
    case 'verified':
      return `You are the approved guardian for ${name}.`
    case 'guardian_started':
      return 'You have accepted. One step left before they can take customers.'
    case 'invited':
      return 'You have not accepted the invitation yet.'
    case 'revoked':
      return 'You withdrew your approval.'
    case 'expired':
      return 'That invitation expired.'
    case 'manual_review':
      return 'Someone on our team is reviewing this account.'
    default:
      return state
  }
}

function describePayout(stage: string): string {
  switch (stage) {
    case 'not_started':
      return 'Not started'
    case 'requirements_due':
      return 'Stripe still needs some details'
    default:
      return stage.replace(/_/g, ' ')
  }
}
