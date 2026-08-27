import Link from 'next/link'
import { AuthForm } from '@/components/AuthForm'
import { Card, Shell } from '@/components/ui'

type Props = { searchParams: Promise<{ next?: string }> }

export const metadata = { title: 'Sign in | Count On Local' }

export default async function SignInPage({ searchParams }: Props) {
  const { next } = await searchParams
  return (
    <Shell narrow>
      <h1>Sign in</h1>
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
