import { notFound } from 'next/navigation'
import { legalDocument } from '@/content/legal'
import { LegalPage } from '@/components/LegalPage'

const doc = legalDocument('safety')

export const metadata = {
  title: `${doc?.title ?? 'Legal'} | Count On Local`,
  description: doc?.summary,
  // A draft must not be indexed. Search results outlive the draft, and a
  // cached snippet of un-finalised terms is exactly the thing that gets
  // quoted back at you.
  robots: doc?.status === 'draft' ? { index: false, follow: false } : undefined,
}

export default function Page() {
  if (!doc) notFound()
  return <LegalPage doc={doc} />
}
