import Link from 'next/link'
import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { authenticate } from '@/server/auth'
import { RouteStopActions } from '@/components/RouteStop'
import { SignOutButton } from '@/components/SignOutButton'
import { Alert, Card, Shell, Stack } from '@/components/ui'

export const metadata = { title: 'Today | Count On Local' }
export const dynamic = 'force-dynamic'

type Stop = {
  occurrenceId: string
  position: number
  state: string
  window: { start: string | null; end: string | null }
  valueCents: number
  address: {
    line1: string
    line2: string | null
    city: string
    region: string
    postalCode: string
    accessNotes: string | null
  } | null
  instructions: string | null
  dog: string | null
  dogWarning: string | null
}

type Route = {
  date: string
  timezone: string
  expectedEarningsCents: number
  estimatedMetres: number
  estimatedMinutes: number
  progress: { done: number; total: number; complete: boolean }
  unplacedCount: number
  stops: Stop[]
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`

/**
 * A service window without the seconds.
 *
 * Postgres serialises a `time` column as 07:00:00, and nobody carrying
 * bins needs the seconds.
 */
const clock = (t: string | null) => (t ? t.slice(0, 5) : null)

/**
 * The round, in the order to walk it.
 *
 * The one screen a provider opens every service morning, so it says the
 * fewest things that matter: how many stops, what they add up to, and what
 * is next. Everything else is a tap away.
 *
 * ## Nothing is recomputed here
 *
 * Ordering, distance, earnings and progress all come from the endpoint,
 * which builds them in domain/route.ts. A page that re-sorted the stops
 * would eventually disagree with the order the provider was told to walk.
 */
export default async function TodayPage() {
  const auth = await authenticate()
  if (!auth.ok) redirect('/signin?next=%2Ftoday')

  const incoming = await headers()
  const host = incoming.get('host') ?? 'localhost:3000'
  const proto =
    incoming.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https')

  const res = await fetch(`${proto}://${host}/api/v1/provider/today`, {
    headers: { cookie: incoming.get('cookie') ?? '' },
    cache: 'no-store',
  })

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { code?: string } }

    // The guardian gate. A minor whose guardian is not cleared cannot run a
    // route, because work that may not be charged for is also work they
    // should not be carrying on with unsupervised.
    if (body.error?.code === 'GUARDIAN_APPROVAL_REQUIRED') {
      return (
        <Shell nav={<SignOutButton />} narrow>
          <h1>Today</h1>
          <Alert kind="error">
            Your guardian approval is not in place, so today&rsquo;s round is on hold.
          </Alert>
          <p className="small muted">
            <Link href="/start">Sort that out</Link>
          </p>
        </Shell>
      )
    }

    if (res.status === 403 || res.status === 404) {
      return (
        <Shell nav={<SignOutButton />} narrow>
          <h1>Today</h1>
          <Alert kind="info">
            This account does not run a route. <Link href="/start">Start a service</Link> if you
            meant to.
          </Alert>
        </Shell>
      )
    }

    return (
      <Shell nav={<SignOutButton />} narrow>
        <h1>Today</h1>
        <Alert kind="error">We could not load your round. Please refresh.</Alert>
      </Shell>
    )
  }

  const route = (await res.json()) as Route
  const remaining = route.stops.filter((s) => s.state !== 'completed' && s.state !== 'settled')

  return (
    <Shell nav={<SignOutButton />} narrow>
      <h1>Today</h1>
      <p className="muted">{route.date}</p>

      {route.stops.length === 0 ? (
        <Card>
          <p className="muted" style={{ marginBottom: 0 }}>
            Nothing on today. Enjoy it.
          </p>
        </Card>
      ) : (
        <Stack>
          <Card>
            <dl className="ledger">
              <div className="ledger__row">
                <dt>Stops</dt>
                <dd>
                  {route.progress.done} of {route.progress.total} done
                </dd>
              </div>
              <div className="ledger__row">
                <dt>You earn today</dt>
                <dd>{money(route.expectedEarningsCents)}</dd>
              </div>
              <div className="ledger__row">
                {/*
                  Labelled an estimate because it is straight-line distance,
                  not street distance -- see domain/route.ts. Presenting it
                  as a real walking time would be a promise the maths does
                  not make.
                */}
                <dt>Rough walk</dt>
                <dd>
                  about {Math.round(route.estimatedMetres / 100) / 10} km,{' '}
                  {route.estimatedMinutes} min
                </dd>
              </div>
            </dl>

            {route.progress.complete ? (
              <Alert kind="success">Round finished. Nice work.</Alert>
            ) : null}
          </Card>

          {route.unplacedCount > 0 ? (
            <Alert kind="info">
              {route.unplacedCount} stop{route.unplacedCount === 1 ? ' is' : 's are'} at the end
              because we could not place the address on the map. The order is still correct for
              everything else.
            </Alert>
          ) : null}

          {route.stops.map((stop) => {
            const done = stop.state === 'completed' || stop.state === 'settled'
            const skipped = stop.state.includes('skipped') || stop.state === 'credited'

            return (
              <Card key={stop.occurrenceId}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                  <h2 style={{ marginBottom: 0 }}>
                    {stop.position}. {stop.address?.line1 ?? 'Address unavailable'}
                  </h2>
                  <span className="small muted">{money(stop.valueCents)}</span>
                </div>

                {stop.address ? (
                  <p className="muted small">
                    {stop.address.line2 ? `${stop.address.line2}, ` : ''}
                    {stop.address.city} {stop.address.postalCode}
                  </p>
                ) : null}

                {stop.window.start ? (
                  <p className="small muted">
                    Between {clock(stop.window.start)} and {clock(stop.window.end)}
                  </p>
                ) : null}

                {stop.dogWarning ? (
                  /*
                    Above the address and the instructions, and styled as a
                    warning rather than a detail. Bite history decides
                    whether a fourteen-year-old should take this animal
                    down a street, and it must not be something they scroll
                    past.
                  */
                  <p className="danger-note" role="alert">
                    <strong>Careful:</strong> {stop.dogWarning}
                  </p>
                ) : null}

                {stop.dog ? <p className="small">Dog: {stop.dog}</p> : null}

                {stop.instructions ? (
                  <p className="small">
                    <strong>They said:</strong> {stop.instructions}
                  </p>
                ) : null}

                {stop.address?.accessNotes ? (
                  /*
                    Gate codes and similar. CLAUDE.md rule 13 keeps these out
                    of notifications, logs and analytics -- on the screen of
                    the person who has to open the gate is the one place they
                    belong. Marked so it is obvious this is not for sharing.
                  */
                  <p className="access-note">
                    <strong>Access:</strong> {stop.address.accessNotes}
                  </p>
                ) : null}

                {done ? (
                  <p className="small" style={{ color: 'var(--col-green)', fontWeight: 700, margin: 0 }}>
                    Done
                  </p>
                ) : skipped ? (
                  <p className="small muted" style={{ margin: 0 }}>
                    Skipped
                  </p>
                ) : (
                  <RouteStopActions occurrenceId={stop.occurrenceId} />
                )}
              </Card>
            )
          })}

          {remaining.length === 0 && route.stops.length > 0 ? (
            <p className="small muted">
              Everything is marked. You get paid when the cycle settles.
            </p>
          ) : null}
        </Stack>
      )}
    </Shell>
  )
}
