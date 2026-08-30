import Link from 'next/link'
import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { authenticate } from '@/server/auth'
import { SignOutButton } from '@/components/SignOutButton'
import {
  EndSubscription,
  ResumeSubscription,
  SkipVisit,
} from '@/components/SubscriptionControls'
import { MessageThread } from '@/components/MessageThread'
import { ReportProblem } from '@/components/ReportProblem'
import { Alert, Card, Shell, Stack } from '@/components/ui'

export const metadata = { title: 'Your services | Count On Local' }
export const dynamic = 'force-dynamic'

type Upcoming = { occurrenceId: string; serviceDate: string; state: string }

type Subscription = {
  id: string
  state: string
  live: boolean
  businessName: string | null
  businessSlug: string | null
  serviceName: string | null
  address: { line1: string; city: string; region: string; postalCode: string } | null
  priceCents: number
  priceUnit: string
  billingCycleWeeks: number
  currentCycle: { start: string | null; end: string | null }
  creditCents: number
  nextServiceDate: string | null
  upcomingCount: number
  upcoming: Upcoming[]
}

type Dashboard = {
  nextService: {
    subscriptionId: string
    serviceDate: string
    businessName: string | null
    serviceName: string | null
  } | null
  subscriptions: Subscription[]
  history: Array<{
    occurrenceId: string
    subscriptionId: string
    serviceDate: string
    state: string
    valueCents: number
  }>
  totalCreditCents: number
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`

/**
 * What a customer sees about the services they buy.
 *
 * Reads the dashboard endpoint rather than the database directly. That
 * endpoint already decides what a customer may see -- which occurrences
 * count as upcoming, which history is theirs, how credit is summed -- and
 * duplicating that here would give two answers to the same question and
 * eventually two different ones.
 */
export default async function SubscriptionsPage() {
  const auth = await authenticate()
  if (!auth.ok) redirect('/signin?next=%2Fsubscriptions')

  // Server-to-server on the same origin, forwarding the caller's cookies so
  // the endpoint authenticates as them rather than as nobody.
  const incoming = await headers()
  const host = incoming.get('host') ?? 'localhost:3000'
  const proto = incoming.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https')

  const res = await fetch(`${proto}://${host}/api/v1/customer/dashboard`, {
    headers: { cookie: incoming.get('cookie') ?? '' },
    cache: 'no-store',
  })

  if (!res.ok) {
    return (
      <Shell nav={<SignOutButton />} narrow>
        <h1>Your services</h1>
        <Alert kind="error">We could not load your services just now. Please refresh.</Alert>
      </Shell>
    )
  }

  const data = (await res.json()) as Dashboard
  const live = data.subscriptions.filter((s) => s.live)
  const ended = data.subscriptions.filter((s) => !s.live)

  if (data.subscriptions.length === 0) {
    return (
      <Shell nav={<SignOutButton />} narrow>
        <h1>Your services</h1>
        <Card>
          <p className="muted" style={{ marginBottom: 0 }}>
            Nothing yet. If a neighbour gave you a link or a flyer, open it and check your address
            there.
          </p>
        </Card>
      </Shell>
    )
  }

  return (
    <Shell nav={<SignOutButton />} narrow>
      <h1>Your services</h1>

      {data.nextService ? (
        <p className="muted">
          Next: {data.nextService.serviceName} on {data.nextService.serviceDate}
        </p>
      ) : null}

      <Stack>
        {data.totalCreditCents > 0 ? (
          <Alert kind="info">
            You have {money(data.totalCreditCents)} of credit. It comes off your next bill
            automatically.
          </Alert>
        ) : null}

        {live.map((s) => (
          <Card key={s.id}>
            <h2>{s.serviceName}</h2>
            <p className="muted small">
              {s.businessSlug ? (
                <Link href={`/${s.businessSlug}`}>{s.businessName}</Link>
              ) : (
                s.businessName
              )}
              {s.address ? ` · ${s.address.line1}` : null}
            </p>

            <dl className="ledger">
              <div className="ledger__row">
                <dt>Price</dt>
                <dd>
                  {money(s.priceCents)}/{s.priceUnit}, billed every {s.billingCycleWeeks} weeks
                </dd>
              </div>
              {s.creditCents > 0 ? (
                <div className="ledger__row">
                  <dt>Credit waiting</dt>
                  <dd>{money(s.creditCents)}</dd>
                </div>
              ) : null}
              <div className="ledger__row">
                <dt>Status</dt>
                <dd>{describeState(s.state)}</dd>
              </div>
            </dl>

            {s.upcoming.length > 0 ? (
              <>
                <h3>Coming up</h3>
                <ul className="list">
                  {s.upcoming.map((o) => (
                    <li key={o.occurrenceId} className="list__item">
                      <span>{o.serviceDate}</span>
                      {/*
                        Skipping is offered on every upcoming visit. Whether
                        it earns a credit depends on notice, and the server
                        decides that -- showing the button only when a credit
                        is certain would quietly stop people cancelling a
                        visit they cannot use.
                      */}
                      <SkipVisit
                        subscriptionId={s.id}
                        occurrenceId={o.occurrenceId}
                        serviceDate={o.serviceDate}
                      />
                    </li>
                  ))}
                </ul>
                {s.upcomingCount > s.upcoming.length ? (
                  <p className="small muted">
                    and {s.upcomingCount - s.upcoming.length} more after that
                  </p>
                ) : null}
              </>
            ) : null}

            <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
              {s.state === 'paused' ? (
                <ResumeSubscription subscriptionId={s.id} />
              ) : (
                <EndSubscription subscriptionId={s.id} kind="pause" />
              )}
              <EndSubscription subscriptionId={s.id} kind="cancel" />
            </div>

            {/* Not buried in a footer. The person who needs this is having
                a bad day and should not have to hunt. */}
            <ReportProblem subscriptionId={s.id} />

            {/* The guardian consent describes this messaging system in the
                document a parent signs. It had no UI until now. */}
            <details className="disclosure">
              <summary>Messages about this service</summary>
              <MessageThread
                subscriptionId={s.id}
                counterpartyLabel={s.businessName ?? 'Your provider'}
              />
            </details>
          </Card>
        ))}

        {data.history.length > 0 ? (
          <Card>
            <h2>Recent visits</h2>
            <ul className="list">
              {data.history.map((h) => (
                <li key={h.occurrenceId} className="list__item">
                  <span>{h.serviceDate}</span>
                  <span className="small muted">
                    {h.state === 'credited' ? 'Credited' : 'Done'} · {money(h.valueCents)}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        {ended.length > 0 ? (
          <Card>
            <h2>Ended</h2>
            <ul className="list">
              {ended.map((s) => (
                <li key={s.id} className="list__item">
                  <span>{s.serviceName}</span>
                  <span className="small muted">{describeState(s.state)}</span>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
      </Stack>
    </Shell>
  )
}

/**
 * State in words a customer would use.
 *
 * `payment_failed` says what to do rather than only what happened. It is
 * the one state where the customer can fix something and the subscription
 * quietly stops working if they do not.
 */
function describeState(state: string): string {
  switch (state) {
    case 'active':
      return 'Running'
    case 'pending':
      return 'Waiting for payment'
    case 'paused':
      return 'Paused'
    case 'payment_failed':
      return 'Payment did not go through — update your card'
    case 'canceled':
      return 'Cancelled'
    case 'ended':
      return 'Finished'
    default:
      return state
  }
}
