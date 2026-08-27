import Link from 'next/link'
import { AuthForm } from '@/components/AuthForm'
import { Alert, Card, Shell } from '@/components/ui'

type Props = { searchParams: Promise<{ next?: string; problem?: string }> }

export const metadata = { title: 'Sign in | Count On Local' }

export default async function SignInPage({ searchParams }: Props) {
  const { next, problem } = await searchParams
  return (
    <Shell narrow>
      <h1>Sign in</h1>
      {problem === 'link' ? (
        <div style={{ marginBottom: 'var(--space-4)' }}>
          <Alert kind="error">
            That link did not work. It may have expired or already been used. Sign in below, or ask
            for a new one.
          </Alert>
        </div>
      ) : null}
      <Card>
        <AuthForm mode="signin" next={next} />
      </Card>
      <p className="small muted" style={{ marginTop: 'var(--space-4)' }}>
        New here?{' '}
        <Link href={next ? `/signup?next=${encodeURIComponent(next)}` : '/signup'}>
          Create an account
        </Link>
      </p>
    </Shell>
  )
}
