import { notFound } from 'next/navigation'
import { legalDocument } from '@/content/legal'
import { LegalPage } from '@/components/LegalPage'
import { pilotRunning } from '@/server/pilotState'

const doc = legalDocument('safety')

export const metadata = {
  title: `${doc?.title ?? 'Legal'} | Count On Local`,
  description: doc?.summary,
  // A draft must not be indexed. Search results outlive the draft, and a
  // cached snippet of un-finalised terms is exactly the thing that gets
  // quoted back at you.
  robots: doc?.status === 'draft' ? { index: false, follow: false } : undefined,
}

// Dynamic because the banner reflects whether an invited pilot is running,
// and that lives in the database rather than in this file. A statically
// cached page would keep saying "no one can sign up yet" after they could.
export const dynamic = 'force-dynamic'

export default async function Page() {
  if (!doc) notFound()
  return <LegalPage doc={doc} pilot={await pilotRunning()} />
}
