import Link from 'next/link'
import { redirect } from 'next/navigation'
import { authenticate } from '@/server/auth'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { SignOutButton } from '@/components/SignOutButton'
import { CloseAccount } from '@/components/CloseAccount'
import { Alert, Card, Shell, Stack } from '@/components/ui'

export const metadata = { title: 'Your account | Count On Local' }
export const dynamic = 'force-dynamic'

/**
 * Where signing in lands.
 *
 * Says who you are, what you can do next, and how to leave.
 *
 * The comment here used to note that the dashboards it links to did not
 * exist yet. They do now -- Today, the business page, the guardian view and
 * subscriptions are all real -- and the note outlived the gap it described.
 */
export default async function AccountPage() {
  const auth = await authenticate()

  if (!auth.ok) {
    // NO_DOMAIN_USER means the provisioning trigger did not fire, which is
    // a real fault rather than a missing session -- but from here the only
    // useful move is still to sign in again.
    redirect('/signin')
  }

  const db = await createSupabaseServerClient()
  const {
    data: { user },
  } = await db.auth.getUser()

  const { data: profile } = await db
    .from('provider_profiles')
    .select('display_first_name, guardian_state')
    .maybeSingle()

  return (
    <Shell nav={<SignOutButton />}>
      <h1>Your account</h1>
      <p className="muted">
        Signed in as {user?.email}
        {auth.auth.roles.length > 0 ? ` · ${auth.auth.roles.join(', ')}` : null}
      </p>

      <Stack>
        {profile ? (
          <Card>
            <h2>Your service</h2>
            <p className="muted">
              {profile.display_first_name
                ? `Set up as ${profile.display_first_name}.`
                : 'Provider profile started.'}{' '}
              Guardian status: {profile.guardian_state.replace(/_/g, ' ')}.
            </p>
            <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
              <Link className="btn" href="/today">
                Today&rsquo;s round
              </Link>
              <Link className="btn btn--secondary" href="/business">
                Your service page
              </Link>
              <Link className="btn btn--secondary" href="/grow">
                Get more customers
              </Link>
            </div>
          </Card>
        ) : (
          <Card>
            <h2>Start a service</h2>
            <p className="muted">
              Run something on your street — bins, lawns, dog walking. You keep the price you set.
            </p>
            <Link className="btn" href="/start">
              Start a service
            </Link>
          </Card>
        )}

        {auth.auth.roles.includes('guardian') ? (
          <Card>
            <h2>Someone you look after</h2>
            <p className="muted">
              Review what they offer, see their scheduled work, and withdraw your approval if you
              need to.
            </p>
            <Link className="btn" href="/guardian">
              Guardian view
            </Link>
          </Card>
        ) : null}

        <Card>
          <h2>Services you buy</h2>
          <p className="muted">
            Pause, skip a visit or cancel at any time. If a neighbour gave you a link or a flyer,
            open it and check your address there.
          </p>
          <Link className="btn" href="/subscriptions">
            Your services
          </Link>
          <p className="small muted" style={{ marginBottom: 0 }}>
            There is no search yet. <Link href="/">The front page</Link> explains why.
          </p>
        </Card>

        {/* Last, because it is destructive and nobody should meet it on
            the way to something else. The Privacy Notice tells people this
            control is here, so it has to be. */}
        <Card>
          <h2>Closing your account</h2>
          <CloseAccount />
        </Card>
      </Stack>
    </Shell>
  )
}
