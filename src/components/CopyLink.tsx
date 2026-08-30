'use client'

import { useState } from 'react'

/**
 * A link with a copy button.
 *
 * The URL is shown in full rather than hidden behind the button. A provider
 * sharing this is often reading it aloud to a neighbour or typing it into
 * somebody else's phone, and a bare "Copy" gives them nothing to read.
 *
 * The clipboard API needs a secure context and permission, and both can be
 * absent. When it fails the text stays selectable and the button says so,
 * rather than silently doing nothing and looking broken.
 */
export function CopyLink({ url }: { url: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')

  return (
    <div className="copylink">
      <code className="copylink__url">{url}</code>
      <button
        className="btn btn--secondary"
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(url)
            setState('copied')
            // Back to idle, so the button does not sit claiming "Copied"
            // long after it stopped being true.
            setTimeout(() => setState('idle'), 2000)
          } catch {
            setState('failed')
          }
        }}
      >
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Select it above' : 'Copy'}
      </button>
    </div>
  )
}
