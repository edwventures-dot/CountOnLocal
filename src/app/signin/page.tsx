import Link from 'next/link'
import { AuthForm } from '@/components/AuthForm'
import { Card, Shell } from '@/components/ui'

export const metadata = { title: 'Sign in | Count On Local' }

export default function SignInPage() {
  return (
    <Shell narrow>
      <h1>Sign in</h1>
      <Card>
        <AuthForm mode="signin" />
      </Card>
      <p className="small muted" style={{ marginTop: 'var(--space-4)' }}>
        New here? <Link href="/signup">Create an account</Link>
      </p>
    </Shell>
  )
}
