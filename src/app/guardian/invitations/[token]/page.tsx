import Link from 'next/link'
import { authenticate } from '@/server/auth'
import { AcceptInvitation } from '@/components/AcceptInvitation'
import { SignOutButton } from '@/components/SignOutButton'
import { Alert, Card, Shell, Stack } from '@/components/ui'

export const metadata = { title: 'Approve an account | Count On Local' }
export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ token: string }> }

/**
 * Where a guardian invitation email lands.
 *
 * ## Nothing is revealed before signing in
 *
 * This page does not look the token up. A signed-out visitor is told what
 * they have been asked to do and nothing about who asked -- not the young
 * person's name, not the service, not the area.
 *
 * The reason is that this link arrived by email at an address a minor typed
 * in, and the mail may have been forwarded, or read on a shared tablet, or
 * sent to the wrong address entirely. Anyone holding the link can reach
 * this page; only somebody willing to create an account can learn who it is
 * about, and that account is the audit trail for the approval.
 *
 * So the token is carried through sign-in and spent by the API, which
 * checks it against a hash and requires a session.
 *
 * ## No detail is shown even after signing in
 *
 * A guardian who accepts here moves to `guardian_started`, not `verified`.
 * The identity step comes after. Showing the provider's details on the
 * strength of the token alone would make the email the credential.
 */
export default async function GuardianInvitationPage({ params }: Params) {
  const { token } = await params
  const auth = await authenticate()

  if (!auth.ok) {
    const next = `/guardian/invitations/${encodeURIComponent(token)}`
    return (
      <Shell narrow>
        <h1>Approve an account</h1>
        <Card>
          <Stack>
            <p className="muted" style={{ marginBottom: 0 }}>
              A young person has asked you to approve their account on Count On Local, where
              neighbours pay for small local services like bins, lawns and dog walking.
            </p>
            <Alert kind="info">
              Sign in or create an account to see who asked and what they want to do. We do not show
              that to anyone holding this link.
            </Alert>
            <Link className="btn btn--full" href={`/signup?next=${encodeURIComponent(next)}`}>
              Create an account
            </Link>
            <p className="small muted" style={{ marginBottom: 0, textAlign: 'center' }}>
              Already have one? <Link href={`/signin?next=${encodeURIComponent(next)}`}>Sign in</Link>
            </p>
          </Stack>
        </Card>
      </Shell>
    )
  }

  return (
    <Shell nav={<SignOutButton />} narrow>
      <h1>Approve an account</h1>
      <Card>
        <AcceptInvitation token={token} />
      </Card>
      <p className="small muted" style={{ marginTop: 'var(--space-4)' }}>
        Approving does not finish the process. You will be asked to confirm who you are before the
        account can take a paying customer.
      </p>
    </Shell>
  )
}
