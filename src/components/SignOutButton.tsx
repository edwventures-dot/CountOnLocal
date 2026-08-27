'use client'

import { useRouter } from 'next/navigation'
import { supabaseBrowser } from '@/lib/supabase/browser'

export function SignOutButton() {
  const router = useRouter()

  async function signOut() {
    await supabaseBrowser().auth.signOut()
    // refresh() before push() so the server components re-render without a
    // session; pushing alone can leave a cached signed-in shell on screen.
    router.refresh()
    router.push('/')
  }

  return (
    <button className="btn btn--link" type="button" onClick={signOut}>
      Sign out
    </button>
  )
}
