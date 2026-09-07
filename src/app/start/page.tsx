import Link from 'next/link'
import { redirect } from 'next/navigation'
import { authenticate } from '@/server/auth'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { onboardingStage, onboardingSteps } from '@/domain/onboarding'
import { ProviderDetailsForm } from '@/components/ProviderDetailsForm'
import { SignOutButton } from '@/components/SignOutButton'
import { Alert, Card, Shell, Stack } from '@/components/ui'

export const metadata = { title: 'Start a service | Count On Local' }
export const dynamic = 'force-dynamic'

/**
 * Provider onboarding, driven by what the database actually says.
 *
 * There is no wizard state in the URL and no step counter in a cookie. The
 * stage is recomputed on every render from the profile, the guardian
 * relationship and the payout mirror, so a guardian who revokes while this
 * page is open sends the provider back a step on refresh rather than
 * leaving them looking at a screen that no longer reflects their position.
 *
 * ## Read with the privileged client, authorised by hand
 *
 * provider_profiles holds a date of birth, so its policies are narrow. The
 * reads here are scoped to the authenticated user's own id, which comes
 * from the session and never from the request.
 */
export default async function StartPage() {
  const auth = await authenticate()
  if (!auth.ok) redirect('/signin?next=%2Fstart')

  const db = supabaseAdmin()
  const userId = auth.auth.userId

  const { data: profile } = await db
    .from('provider_profiles')
    .select('display_first_name')
    .eq('user_id', userId)
    .maybeSingle()
  const stage = onboardingStage({ hasProviderProfile: Boolean(profile) })

  const steps = onboardingSteps({ stage })

  return (
    <Shell nav={<SignOutButton />} narrow>
      <h1>Start a service</h1>

      <ol className="steps">
        {steps.map((step) => (
          <li key={step.key} className={`steps__item steps__item--${step.state}`}>
            {step.label}
          </li>
        ))}
      </ol>

      {stage === 'details' ? (
        <Card>
          <h2>Your details</h2>
          <ProviderDetailsForm />
        </Card>
      ) : null}

      {stage === 'ready' ? (
        <Stack>
          <Card>
            <h2>You are set up</h2>
            <p className="muted" style={{ marginBottom: 0 }}>
              {profile?.display_first_name ? `Nice one, ${profile.display_first_name}. ` : ''}
              Your account is ready. Build your page and share it with your neighbours.
            </p>
          </Card>
          <Link className="btn" href="/business">
            Build my service page
          </Link>
          <p className="small muted">
            <Link href="/account">Back to your account</Link>
          </p>
        </Stack>
      ) : null}
    </Shell>
  )
}

