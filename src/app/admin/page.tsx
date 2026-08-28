import { notFound, redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { authenticate } from '@/server/auth'
import { hasPermission } from '@/domain/roles'
import { PayoutHold, ResolveIncident } from '@/components/AdminControls'
import { SignOutButton } from '@/components/SignOutButton'
import { RESPONSE_TARGET_MINUTES, type IncidentSeverity } from '@/domain/incident'
import { Alert, Card, Shell, Stack } from '@/components/ui'

export const metadata = { title: 'Trust and safety | Count On Local' }
export const dynamic = 'force-dynamic'

type QueueItem = {
  incidentId: string
  severity: IncidentSeverity
  state: string
  category: string
  involvesMinor: boolean
  respondBy: string
  overdue: boolean
  createdAt: string
}

/**
 * The trust and safety console.
 *
 * PRD section 24. Everything here writes an audit row with an actor and a
 * reason, because the point of staff tooling on a platform with minors on
 * it is not speed -- it is that somebody can reconstruct, months later,
 * who did what and why.
 *
 * ## 404, not 403
 *
 * A caller without the permission gets notFound(). A 403 tells somebody
 * probing that this console exists and that they nearly reached it. The
 * queue endpoint does the same.
 *
 * ## What is deliberately absent
 *
 * No search by name. No customer addresses. No provider profiles. Reading
 * a customer address is a separate, individually audited action
 * (readCustomerAddress), and a queue that carried addresses alongside
 * would make that audit trail decorative. Staff work from ids that came
 * from a report.
 */
export default async function AdminPage() {
  const auth = await authenticate()
  if (!auth.ok) redirect('/signin?next=%2Fadmin')

  if (!hasPermission(auth.auth.roles, 'incident:manage')) notFound()

  const incoming = await headers()
  const host = incoming.get('host') ?? 'localhost:3000'
  const proto =
    incoming.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https')

  const res = await fetch(`${proto}://${host}/api/v1/admin/incidents`, {
    headers: { cookie: incoming.get('cookie') ?? '' },
    cache: 'no-store',
  })

  if (!res.ok) notFound()

  const { items } = (await res.json()) as { items: QueueItem[] }
  const overdue = items.filter((i) => i.overdue)
  const canRelease = hasPermission(auth.auth.roles, 'payout:release')
  const canHold = hasPermission(auth.auth.roles, 'payout:hold')

  return (
    <Shell nav={<SignOutButton />}>
      <h1>Trust and safety</h1>
      <p className="muted">
        {items.length === 0
          ? 'Nothing open.'
          : `${items.length} open${overdue.length > 0 ? `, ${overdue.length} past the response target` : ''}`}
      </p>

      <Stack>
        {overdue.length > 0 ? (
          <Alert kind="error">
            {overdue.length} incident{overdue.length === 1 ? ' is' : 's are'} past the response
            target. They are at the top.
          </Alert>
        ) : null}

        {items.map((item) => (
          <Card key={item.incidentId}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
              <h2 style={{ marginBottom: 0 }}>
                <span className={`sev sev--${item.severity.toLowerCase()}`}>{item.severity}</span>{' '}
                {item.category.replace(/_/g, ' ')}
              </h2>
              {item.overdue ? (
                <span className="small" style={{ color: 'var(--col-red)', fontWeight: 700 }}>
                  Overdue
                </span>
              ) : null}
            </div>

            <dl className="ledger">
              <div className="ledger__row">
                <dt>Respond by</dt>
                <dd>
                  {item.respondBy.replace('T', ' ').slice(0, 16)} (
                  {targetInWords(item.severity)})
                </dd>
              </div>
              <div className="ledger__row">
                <dt>State</dt>
                <dd>{item.state}</dd>
              </div>
              {item.involvesMinor ? (
                <div className="ledger__row">
                  {/*
                    Flagged, not detailed. That a minor is involved changes
                    how this is handled; who they are is not needed to
                    triage it and is not shown.
                  */}
                  <dt>Involves a minor</dt>
                  <dd>Yes</dd>
                </div>
              ) : null}
              <div className="ledger__row">
                <dt>Reference</dt>
                <dd className="small muted">{item.incidentId}</dd>
              </div>
            </dl>

            <ResolveIncident incidentId={item.incidentId} />
          </Card>
        ))}

        {canHold ? (
          <Card>
            <h2>Hold payouts</h2>
            <p className="muted small">
              Stops money reaching a provider while something is looked into. Their customers are
              not affected.
            </p>
            <PayoutHold />
          </Card>
        ) : null}

        {canRelease ? (
          <Card>
            <h2>Release payouts</h2>
            <p className="muted small">
              {/*
                Separation of duties: a trust_safety_agent can place a hold
                and cannot lift one. Showing both panels to whoever holds
                both permissions makes that visible rather than mysterious.
              */}
              A different permission from placing a hold, on purpose.
            </p>
            <PayoutHold held />
          </Card>
        ) : null}
      </Stack>
    </Shell>
  )
}

function targetInWords(severity: IncidentSeverity): string {
  const minutes = RESPONSE_TARGET_MINUTES[severity]
  if (minutes < 60) return `${minutes} min target`
  if (minutes < 60 * 24) return `${minutes / 60} hr target`
  return `${minutes / (60 * 24)} day target`
}
