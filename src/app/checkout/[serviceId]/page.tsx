import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@supabase/supabase-js'
import { authenticate } from '@/server/auth'
import { publicEnv } from '@/lib/env'
import { Checkout } from '@/components/Checkout'
import { SignOutButton } from '@/components/SignOutButton'
import { Card, Shell } from '@/components/ui'
import type { Database } from '@/lib/supabase/types'

export const metadata = { title: 'Subscribe | Count On Local' }
export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ serviceId: string }> }

/**
 * Where "Check my address" on a storefront leads.
 *
 * Signing in is required before this page renders anything, because
 * everything past it creates a subscription against a real person. The
 * storefront's own address check stays unauthenticated on purpose -- a
 * neighbour holding a flyer must be able to ask "do you come here" without
 * making an account first -- and this is where that stops being enough.
 *
 * The service is read through the ANON client, so an unpublished service is
 * invisible here for the same reason it is invisible on the storefront: the
 * row level policy decides, not this file.
 */
export default async function CheckoutPage({ params }: Params) {
  const { serviceId } = await params

  const auth = await authenticate()
  if (!auth.ok) {
    redirect(`/signin?next=${encodeURIComponent(`/checkout/${serviceId}`)}`)
  }

  const env = publicEnv()
  const db = createClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  )

  const { data: service } = await db
    .from('provider_services')
    .select('id, public_name, service_catalog!inner(code), businesses!inner(name, slug)')
    .eq('id', serviceId)
    .maybeSingle()

  if (!service) {
    return (
      <Shell narrow>
        <h1>Not found</h1>
        <p className="muted">
          That service is not available. <Link href="/">Back to the front page</Link>
        </p>
      </Shell>
    )
  }

  const business = service.businesses as unknown as { name: string; slug: string }
  // Passed so the checkout form knows whether to ask about a dog. Read
  // from the catalog rather than guessed from the public name, which a
  // provider chooses freely.
  const catalogCode =
    (
      (Array.isArray(service.service_catalog)
        ? service.service_catalog[0]
        : service.service_catalog) as { code?: string } | undefined
    )?.code ?? ''

  return (
    <Shell nav={<SignOutButton />} narrow>
      <h1>Subscribe</h1>
      <p className="muted">
        {service.public_name} from <Link href={`/${business.slug}`}>{business.name}</Link>
      </p>
      <Card>
        <Checkout serviceId={serviceId} serviceCatalogHint={catalogCode} />
      </Card>
    </Shell>
  )
}
