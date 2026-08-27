import Link from 'next/link'
import { AuthForm } from '@/components/AuthForm'
import { Card, Shell } from '@/components/ui'

type Props = { searchParams: Promise<{ next?: string }> }

export const metadata = { title: 'Create an account | Count On Local' }

/**
 * Credentials only. No date of birth here, deliberately.
 *
 * The age rules differ by what you are doing rather than by who you are: a
 * provider gives a date of birth at onboarding, where the server decides
 * guardian state from it, and a customer attests to being 18 at checkout.
 * Collecting a DOB at signup would gather a minor's exact age from someone
 * who might only ever be a customer -- and CLAUDE.md rule 1 keeps exact age
 * out of anywhere it is not needed.
 */
export default async function SignUpPage({ searchParams }: Props) {
  const { next } = await searchParams
  return (
    <Shell narrow>
      <h1>Create an account</h1>
      <p className="muted">
        One account works for both sides. You can hire someone on your street, run your own
        service, or do both.
      </p>
      <Card>
        <AuthForm mode="signup" next={next} />
      </Card>
      <p className="small muted" style={{ marginTop: 'var(--space-4)' }}>
        Already have an account?{' '}
        <Link href={next ? `/signin?next=${encodeURIComponent(next)}` : '/signin'}>Sign in</Link>
      </p>
    </Shell>
  )
}
