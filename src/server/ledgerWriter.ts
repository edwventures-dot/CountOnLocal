/**
 * Writes ledger entries.
 *
 * The domain decides what the entries are (src/domain/ledger.ts); this puts
 * them in the table. Kept apart because the shape of a balanced charge is a
 * money rule that deserves unit tests, while this is I/O.
 *
 * Two properties this file is responsible for.
 *
 * Idempotency. TECHNICAL_SPEC section 11 requires that a replayed webhook
 * cannot double-post. ledger_entries.idempotency_key is UNIQUE, so a second
 * write of the same event hits a constraint violation rather than silently
 * doubling a provider's earnings. That violation is treated as success,
 * because it means the work was already done -- but only for the exact
 * duplicate, never for a partially-written set.
 *
 * All-or-nothing. A charge is three rows that must land together; two of
 * three is an unbalanced subscription, which is the one thing the sign
 * convention exists to make impossible. Supabase's REST insert of an array
 * is a single statement and therefore a single transaction, so the rows go
 * in together or not at all. Do not "helpfully" split this into a loop.
 */

import type { LedgerEntry } from '@/domain/ledger'
import { isBalanced } from '@/domain/ledger'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'

type Db = SupabaseClient<Database>

/** Postgres unique-violation. A duplicate idempotency key lands here. */
const UNIQUE_VIOLATION = '23505'

export type WriteLedgerResult =
  | { ok: true; written: number; duplicate: false }
  /** The event was already recorded. Not an error. */
  | { ok: true; written: 0; duplicate: true }
  | { ok: false; code: 'UNBALANCED' | 'WRITE_FAILED'; message: string }

function toRow(e: LedgerEntry) {
  return {
    kind: e.kind,
    amount_cents: e.amountCents,
    currency: e.currency,
    subscription_id: e.subscriptionId ?? null,
    occurrence_id: e.occurrenceId ?? null,
    customer_user_id: e.customerUserId ?? null,
    provider_user_id: e.providerUserId ?? null,
    external_processor: e.externalProcessor ?? null,
    external_id: e.externalId ?? null,
    idempotency_key: e.idempotencyKey ?? null,
    memo: e.memo ?? null,
  }
}

/**
 * Writes a set of entries that must balance -- a cycle charge, say.
 *
 * `db` must be the PRIVILEGED client: ledger_entries has RLS forced and no
 * write policy for anyone, so this is deliberately a server-only path.
 */
export async function writeBalancedEntries(args: {
  db: Db
  entries: readonly LedgerEntry[]
}): Promise<WriteLedgerResult> {
  const { db, entries } = args

  if (entries.length === 0) return { ok: true, written: 0, duplicate: true }

  if (!isBalanced(entries)) {
    // Refuse rather than write. An unbalanced set in the table is far
    // harder to find later than a failed request now.
    return {
      ok: false,
      code: 'UNBALANCED',
      message: 'Refusing to write a ledger set that does not sum to zero',
    }
  }

  return insert(db, entries)
}

/**
 * Writes entries that are not expected to balance on their own -- a credit
 * awaiting its offsetting smaller charge next cycle, or a payout that
 * settles earnings across many subscriptions.
 *
 * Separate function rather than a flag, so that skipping the balance check
 * is a decision someone made on purpose and can be found by grep.
 */
export async function writeStandaloneEntries(args: {
  db: Db
  entries: readonly LedgerEntry[]
}): Promise<WriteLedgerResult> {
  if (args.entries.length === 0) return { ok: true, written: 0, duplicate: true }
  return insert(args.db, args.entries)
}

async function insert(db: Db, entries: readonly LedgerEntry[]): Promise<WriteLedgerResult> {
  const { error } = await db.from('ledger_entries').insert(entries.map(toRow))

  if (!error) return { ok: true, written: entries.length, duplicate: false }

  if (error.code === UNIQUE_VIOLATION) {
    // Already recorded. The unique index did its job.
    return { ok: true, written: 0, duplicate: true }
  }

  console.error('[ledger] write failed', { code: error.code, message: error.message })
  return { ok: false, code: 'WRITE_FAILED', message: error.message }
}
