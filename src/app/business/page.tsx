import Link from 'next/link'
import { redirect } from 'next/navigation'
import { authenticate } from '@/server/auth'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { getPublishReadiness } from '@/server/businessService'
import { formatCents } from '@/domain/money'
import {
  AddServiceForm,
  CreateBusinessForm,
  PublishButton,
  ServiceAreaForm,
  ServiceStateToggle,
} from '@/components/BusinessForms'
import { SignOutButton } from '@/components/SignOutButton'
import { Alert, Card, Shell, Stack } from '@/components/ui'
import type { PublishBlocker } from '@/domain/publish'

export const metadata = { title: 'Your business | Count On Local' }
export const dynamic = 'force-dynamic'

/**
 * The business and service builder.
 *
 * One page rather than a wizard. UX_UI_SPEC section 9 asks for "a progress
 * indicator by meaningful stage, not Step 7 of 15 anxiety", and the honest
 * reading of that is to show the whole thing and mark what is left --
 * building a service page is not a linear form, it is a checklist people
 * come back to.
 *
 * ## The checklist is the publish gate
 *
 * getPublishReadiness runs the same code publishBusiness runs. Nothing here
 * re-implements a rule, because a checklist that drifts from the gate is
 * worse than no checklist: it teaches people to distrust it, and then the
 * one time it matters they press publish anyway.
 */
export default async function BusinessPage() {
  const auth = await authenticate()
  if (!auth.ok) redirect('/signin?next=%2Fbusiness')

  const db = supabaseAdmin()
  const userId = auth.auth.userId

  const { data: profile } = await db
    .from('provider_profiles')
    .select('user_id')
    .eq('user_id', userId)
    .maybeSingle()

  // No provider profile means they have not been through /start. Sending
  // them there beats showing a form that will fail on submit.
  if (!profile) redirect('/start')

  // Migration 0008: "Drafts may accumulate; a provider cannot run two
  // public storefronts at once." So there can legitimately be several rows
  // here, and only one of them can be live. Pick the live one if there is
  // one, otherwise the most recent draft -- a newer draft must not hide a
  // published storefront the provider is actually running.
  const { data: businesses } = await db
    .from('businesses')
    .select('id, name, slug, state, public_area_label, created_at')
    .eq('provider_user_id', userId)
    .neq('state', 'closed')
    .order('created_at', { ascending: false })

  const LIVE = new Set(['published', 'pending', 'paused_guardian', 'paused_admin'])
  const business =
    (businesses ?? []).find((b) => LIVE.has(b.state)) ?? (businesses ?? [])[0] ?? null

  if (!business) {
    return (
      <Shell nav={<SignOutButton />} narrow>
        <h1>Your business</h1>
        <Card>
          <h2>Name it</h2>
          <CreateBusinessForm />
        </Card>
      </Shell>
    )
  }

  const [{ data: services }, { data: catalog }, readiness] = await Promise.all([
    db
      .from('provider_services')
      .select('id, public_name, price_cents, price_unit, state')
      .eq('business_id', business.id)
      .order('created_at'),
    db
      .from('service_catalog')
      .select('code, name, description')
      .order('risk_tier')
      .order('name'),
    getPublishReadiness({ db, providerUserId: userId, businessId: business.id, now: new Date() }),
  ])

  const blockers = readiness.ok ? readiness.blockers : []
  const areaByService = new Map(
    (readiness.ok ? readiness.services : []).map((s) => [s.id, s.hasServiceArea]),
  )
  const published = business.state === 'published'

  return (
    <Shell nav={<SignOutButton />} narrow>
      <h1>{business.name}</h1>
      <p className="muted">
        {published ? (
          <>
            Live at <Link href={`/${business.slug}`}>countonlocal.com/{business.slug}</Link>
          </>
        ) : (
          'Not published yet. Only you can see this.'
        )}
      </p>

      <Stack>
        <Card>
          <h2>What you offer</h2>
          {(services ?? []).length === 0 ? (
            <p className="muted">Nothing yet. Add your first service below.</p>
          ) : (
            <ul className="list">
              {(services ?? []).map((s) => (
                <li key={s.id} className="list__item">
                  <div>
                    <strong>{s.public_name}</strong>
                    <span className="muted small">
                      {' '}
                      {formatCents(s.price_cents)}/{s.price_unit}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                    <span className="small muted">
                      {s.state === 'active' ? 'On' : s.state === 'paused' ? 'Paused' : 'Draft'}
                    </span>
                    <ServiceStateToggle serviceId={s.id} state={s.state} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {(services ?? [])
          .filter((s) => !areaByService.get(s.id))
          .map((s) => (
            <Card key={s.id}>
              <h2>Where you go for {s.public_name}</h2>
              <ServiceAreaForm serviceId={s.id} />
            </Card>
          ))}

        <Card>
          <h2>{(services ?? []).length === 0 ? 'Add a service' : 'Add another'}</h2>
          <AddServiceForm businessId={business.id} catalog={catalog ?? []} />
        </Card>

        <Card>
          <h2>{published ? 'Your page is live' : 'Before you can publish'}</h2>
          {published ? (
            <p className="muted" style={{ marginBottom: 0 }}>
              Neighbours can find you and check their address.
            </p>
          ) : blockers.length === 0 ? (
            <Stack>
              <Alert kind="success">Everything is ready.</Alert>
              <PublishButton businessId={business.id} />
            </Stack>
          ) : (
            <Stack>
              <ul className="list">
                {blockers.map((b) => (
                  <li key={b} className="list__item">
                    <span>{explainBlocker(b)}</span>
                  </li>
                ))}
              </ul>
              <p className="small muted" style={{ marginBottom: 0 }}>
                This is the same check that runs when you press publish, so nothing here is a
                surprise later.
              </p>
            </Stack>
          )}
        </Card>
      </Stack>
    </Shell>
  )
}

/**
 * A blocker in words, and what to do about it.
 *
 * PROVIDER_INELIGIBLE stays vague on purpose: it covers age and suspension,
 * and spelling out which would tell a suspended account what tripped it.
 */
function explainBlocker(blocker: PublishBlocker): string {
  switch (blocker) {
    case 'GUARDIAN_APPROVAL_REQUIRED':
      return 'Your guardian has not approved yet. Finish that on the Start page.'
    case 'PAYOUT_ONBOARDING_INCOMPLETE':
      return 'Payouts are not set up, so there would be nowhere to send your money.'
    case 'NO_ACTIVE_SERVICE':
      return 'Add at least one service.'
    case 'SERVICE_MISSING_AREA':
      return 'One of your services has no area yet, so nobody can check their address.'
    case 'SERVICE_MISSING_SCHEDULE':
      return 'One of your services has no day set.'
    case 'BUSINESS_MISSING_AREA_LABEL':
      return 'Add an area name so neighbours know roughly where you cover.'
    case 'ALREADY_PUBLISHED':
      return 'This page is already published.'
    default:
      return 'This account cannot publish right now. Contact support if that seems wrong.'
  }
}
