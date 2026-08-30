/**
 * Telling a provider something, and their guardian with them.
 *
 * ## Why the guardian is a recipient and not an afterthought
 *
 * The consent a guardian signs says they oversee the money and that the
 * customer's address is shared with them "so the work can happen".
 * Oversight of something nobody tells you about is not oversight, so
 * anything that changes what a minor is committed to — a new customer, a
 * public review of their work — goes to both.
 *
 * An adult provider has no guardian and gets one message. The same call
 * covers both cases, which is the point: a caller that had to ask "is this
 * one a minor" would eventually forget to.
 *
 * ## What may go in a preview
 *
 * These land on a lock screen, so the rule from SAFETY_TRUST_POLICY 14
 * applies at its strictest: no customer name, no address, no access code,
 * no rating. The provider's own service name is theirs and is safe. The
 * message says that something happened and where to look.
 *
 * The lifted-from note: this was a private helper inside agingJob, which
 * needed exactly the same "both parties" lookup. Two copies of a rule about
 * who hears about a minor's business is one copy too many.
 */

import { enqueueNotification } from '@/server/notifications'
import type { NotificationKind } from '@/domain/notification'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'

type Db = SupabaseClient<Database>

export type Recipient = {
  userId: string
  email: string | null
  role: 'provider' | 'guardian'
}

/**
 * The provider, and their guardian when there is a live one.
 *
 * A revoked or expired relationship is excluded: that guardian has stepped
 * away and should stop hearing about this teenager's customers.
 */
export async function providerAndGuardian(
  db: Db,
  providerUserId: string,
): Promise<Recipient[]> {
  const out: Recipient[] = []

  const { data: provider } = await db
    .from('users')
    .select('id, email')
    .eq('id', providerUserId)
    .maybeSingle()
  if (provider) out.push({ userId: provider.id, email: provider.email, role: 'provider' })

  const { data: rel } = await db
    .from('guardian_relationships')
    .select('guardian_user_id')
    .eq('provider_user_id', providerUserId)
    .not('state', 'in', '(revoked,expired)')
    .maybeSingle()

  if (rel?.guardian_user_id) {
    const { data: guardian } = await db
      .from('users')
      .select('id, email')
      .eq('id', rel.guardian_user_id)
      .maybeSingle()
    if (guardian) out.push({ userId: guardian.id, email: guardian.email, role: 'guardian' })
  }

  return out
}

/**
 * Queues one notice per party.
 *
 * Never throws. These are told-you-about-it messages hanging off a path
 * that has already succeeded — a subscription that is active, a review
 * that is published — and failing that path because an email could not be
 * queued would undo real work to deliver a nicety.
 *
 * The idempotency key is suffixed per recipient, so the provider and the
 * guardian each get exactly one and neither blocks the other.
 */
export async function noticeToProviderAndGuardian(args: {
  db: Db
  providerUserId: string
  now: Date
  /** Unique to the event, not to the run. */
  idempotencyKey: string
  kind: NotificationKind
  subject: string
  preview: string
  payload?: Record<string, unknown>
}): Promise<number> {
  try {
    const parties = await providerAndGuardian(args.db, args.providerUserId)
    let queued = 0

    for (const party of parties) {
      if (!party.email) continue
      const sent = await enqueueNotification({
        db: args.db,
        recipientUserId: party.userId,
        now: args.now,
        idempotencyKey: `${args.idempotencyKey}:${party.role}`,
        draft: {
          kind: args.kind,
          channel: 'email',
          destination: party.email,
          subject: args.subject,
          preview: args.preview,
          payload: { ...(args.payload ?? {}), role: party.role },
        },
      })
      if (sent) queued += 1
    }

    return queued
  } catch (err) {
    console.error('[notices] could not queue a provider notice', {
      providerUserId: args.providerUserId,
      kind: args.kind,
      message: err instanceof Error ? err.message : String(err),
    })
    return 0
  }
}
