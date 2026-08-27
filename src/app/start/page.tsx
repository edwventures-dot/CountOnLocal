import Link from 'next/link'
import { redirect } from 'next/navigation'
import { authenticate } from '@/server/auth'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { getPayoutStatus } from '@/server/connectOnboarding'
import { onboardingStage, onboardingSteps } from '@/domain/onboarding'
import { classifyAge, parsePlainDate } from '@/domain/age'
import { todayUtc } from '@/server/providerOnboarding'
import { ProviderDetailsForm } from '@/components/ProviderDetailsForm'
import { GuardianInviteForm } from '@/components/GuardianInviteForm'
import { PayoutStart } from '@/components/PayoutStart'
import { SignOutButton } from '@/components/SignOutButton'
import { Alert, Card, Shell, Stack } from '@/components/ui'
import type { GuardianState } from '@/domain/guardian'

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
    .select('display_first_name, date_of_birth, guardian_state')
    .eq('user_id', userId)
    .maybeSingle()

  const payout = profile
    ? await getPayoutStatus({ db, providerUserId: userId, now: new Date() })
    : null

  const guardianState = (profile?.guardian_state ?? null) as GuardianState | null
  const stage = onboardingStage({
    hasProviderProfile: Boolean(profile),
    guardianState,
    payoutReady: payout?.ok ? payout.status.canReceivePayments : false,
  })

  // Derived rather than stored. There is no is_minor column to tamper with.
  const guardianRequired = profile
    ? classifyAge(parsePlainDate(profile.date_of_birth), todayUtc(new Date())) === 'minor'
    : false

  const steps = onboardingSteps({ stage, guardianRequired })

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

      {stage === 'guardian' ? (
        <Stack>
          <Card>
            <h2>Guardian approval</h2>
            <GuardianStatus state={guardianState} />
            <GuardianInviteForm alreadyInvited={guardianState === 'invited'} />
          </Card>
          <p className="small muted">
            You can build your service page while you wait. You just cannot take a paying customer
            until your guardian is verified.
          </p>
        </Stack>
      ) : null}

      {stage === 'payouts' ? (
        <Card>
          <h2>Getting paid</h2>
          <PayoutStart holder={guardianRequired ? 'guardian' : 'self'} />
        </Card>
      ) : null}

      {stage === 'ready' ? (
        <Stack>
          <Card>
            <h2>You are set up</h2>
            <p className="muted" style={{ marginBottom: 0 }}>
              {profile?.display_first_name ? `Nice one, ${profile.display_first_name}. ` : ''}
              Your account can take a paying customer.
            </p>
          </Card>
          <Alert kind="info">
            The next step is building your service page, and that screen is not built yet. The API
            behind it is.
          </Alert>
          <p className="small muted">
            <Link href="/account">Back to your account</Link>
          </p>
        </Stack>
      ) : null}
    </Shell>
  )
}

/**
 * What the guardian relationship is doing, in words.
 *
 * `manual_review` deliberately does not tell the provider what triggered it.
 * SAFETY_TRUST_POLICY keeps the detail of a review with the staff running
 * it -- telling somebody which signal tripped is telling them what to avoid
 * next time.
 */
function GuardianStatus({ state }: { state: GuardianState | null }) {
  switch (state) {
    case 'invited':
      return (
        <Alert kind="info">
          We have sent the request. Nothing happens until they open it and approve.
        </Alert>
      )
    case 'guardian_started':
      return (
        <Alert kind="info">
          They have started. There is one more step on their side before you can take customers.
        </Alert>
      )
    case 'revoked':
      return (
        <Alert kind="error">
          Your guardian withdrew their approval. New customers and charges have stopped. Talk to
          them, then send a new request below.
        </Alert>
      )
    case 'expired':
      return (
        <Alert kind="error">
          That request expired before it was opened. Send a new one below.
        </Alert>
      )
    case 'manual_review':
      return (
        <Alert kind="info">
          Someone on our team is reviewing this account. We will be in touch.
        </Alert>
      )
    default:
      return (
        <p className="muted">
          You are under 18, so a parent or guardian has to approve your account before anyone can
          pay you. It takes them a couple of minutes.
        </p>
      )
  }
}
