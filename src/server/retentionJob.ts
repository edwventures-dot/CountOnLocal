/**
 * Enforcing the retention policy, and closing accounts.
 *
 * The policy itself -- every period, every reason, every refusal to erase
 * on request -- lives in src/domain/retention.ts. Nothing here decides how
 * long anything is kept; this file only carries the decisions out.
 *
 * That split is the point. A retention policy that lives in a job is a
 * policy nobody outside the codebase can review, and this one has to be
 * reviewable by somebody who does not read TypeScript.
 *
 * ## Two entry points
 *
 *   runRetention  -- the daily sweep. Visits every class the policy says
 *                    holds personal data in its own columns, and expires
 *                    what is past its date.
 *   closeAccount  -- somebody asked to be deleted. Applies the erase-now
 *                    classes immediately and de-identifies the account row.
 *
 * ## Why closure does not delete the user row
 *
 * It cannot. `consent_records.signer_user_id`,
 * `completion_photos.uploaded_by_user_id` and the incident references are
 * all `on delete restrict`, so a DELETE against a user who has ever signed
 * a consent, uploaded a photo or been named in a report fails on a foreign
 * key. That was true before this file existed and it is the correct
 * behaviour, so it is built on rather than worked around.
 *
 * What closure does instead: replace the contact details and display names,
 * leave every reference intact. The ids in the ledger still point
 * somewhere; what they point at no longer names a person.
 *
 * ## Partial failure
 *
 * Each class is swept independently and a failure in one is recorded and
 * stepped over. A storage bucket that is briefly unreachable must not stop
 * a stranger's address being cleared, and the next run picks up whatever
 * the last one missed -- every operation here is idempotent, because each
 * one either matches rows past a date or matches nothing.
 */

import {
  cutoffFor,
  deletionEffect,
  DORMANCY_WARNING_DAYS,
  REDACTED,
  RETENTION,
  tombstoneEmail,
  type RetentionClass,
} from '@/domain/retention'
import { enqueueNotification } from '@/server/notifications'
import { providerBalanceCents } from '@/domain/ledger'
import { purgeExpiredMessages } from '@/server/messageService'
import { writeAudit } from '@/server/audit'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'

type Db = SupabaseClient<Database>

const PHOTO_BUCKET = 'completion-photos'

/**
 * How many rows one class may touch in a single run.
 *
 * A cap rather than "everything past the date", so the first run after a
 * period is shortened cannot rewrite a million rows inside one request
 * timeout and leave the job half-done with no record of where it stopped.
 * Whatever is left is picked up tomorrow.
 */
const BATCH = 500

export type RetentionRunResult = {
  /** Rows affected, by class. Absent means the class was not swept. */
  expired: Partial<Record<RetentionClass, number>>
  /** Closed accounts de-identified this run. */
  accountsDeIdentified: number
  /** Dormant accounts warned that they are about to be retired. */
  dormancyWarnings: number
  /**
   * Dormant accounts that could not be retired because money is owed or a
   * subscription is still live. Reported rather than skipped silently: a
   * number that never falls to zero is somebody's money sitting unclaimed.
   */
  dormantBlocked: number
  failures: Array<{ step: string; message: string }>
}

export async function runRetention(args: { db: Db; now: Date }): Promise<RetentionRunResult> {
  const result: RetentionRunResult = {
    expired: {},
    accountsDeIdentified: 0,
    dormancyWarnings: 0,
    dormantBlocked: 0,
    failures: [],
  }

  const step = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[retention] ${name} failed`, message)
      result.failures.push({ step: name, message })
    }
  }

  await step('messages', async () => {
    // Already built, already scheduled by purge_after on the row. Called
    // from here rather than separately so there is one sweep and one place
    // to look when asking what the platform deleted today.
    const { purged } = await purgeExpiredMessages({ db: args.db, now: args.now, limit: BATCH })
    result.expired.message_ordinary = purged
  })

  await step('completion_photos', async () => {
    result.expired.completion_photo = await expirePhotos(args)
  })

  await step('notifications', async () => {
    result.expired.notification = await expireNotifications(args)
  })

  await step('customer_addresses', async () => {
    result.expired.customer_address = await expireAddresses(args)
  })

  await step('consent_records', async () => {
    result.expired.consent_record = await expireConsentRecords(args)
  })

  await step('dormant_accounts', async () => {
    const dormant = await expireDormantAccounts(args)
    result.expired.account_identity = dormant.retired
    result.dormancyWarnings = dormant.warned
    result.dormantBlocked = dormant.blocked
  })

  // After the dormancy pass, so an account retired this run is finished in
  // the same run rather than waiting for tomorrow.
  await step('close_out_accounts', async () => {
    result.accountsDeIdentified = await deIdentifyClosedAccounts(args)
  })

  return result
}

/**
 * Accounts nobody has touched in years.
 *
 * The clock comes from account_retention_clock (migration 0039), which
 * counts real activity only -- notifications the platform sent are
 * excluded, or an automated reminder would keep an abandoned account alive
 * forever.
 *
 * Two passes, in this order:
 *
 *   1. warn anything due to expire within DORMANCY_WARNING_DAYS, while
 *      the email address still exists to warn it at;
 *   2. retire anything already past its date.
 *
 * Both refusals from closeAccount apply here and matter more, because
 * nobody asked for this. An account owed money is left alone and counted,
 * so unclaimed earnings surface as a number somebody can act on rather
 * than as an account quietly emptied of the details needed to pay it.
 */
async function expireDormantAccounts(args: {
  db: Db
  now: Date
}): Promise<{ warned: number; retired: number; blocked: number }> {
  const rule = RETENTION.account_identity
  const cutoff = cutoffFor({ rule, now: args.now })
  const warnCutoff = new Date(cutoff.getTime() + DORMANCY_WARNING_DAYS * 86_400_000)

  const { data, error } = await args.db
    .from('account_retention_clock')
    .select('user_id, last_active_at, has_live_subscription, closed_at, de_identified_at')
    .is('de_identified_at', null)
    .lt('last_active_at', warnCutoff.toISOString())
    .limit(BATCH)

  if (error) throw new Error(error.message)

  let warned = 0
  let retired = 0
  let blocked = 0

  for (const row of data ?? []) {
    const lastActive = new Date(row.last_active_at as string)
    const due = lastActive < cutoff

    if (row.has_live_subscription) {
      // Live subscription means the account is not dormant at all -- the
      // clock is measuring the wrong thing for this person. Left alone.
      blocked += 1
      continue
    }

    const owed = await amountOwed(args.db, row.user_id as string)
    if (owed > 0) {
      blocked += 1
      continue
    }

    if (!due) {
      if (await warnOfDormancy({ db: args.db, userId: row.user_id as string, now: args.now })) {
        warned += 1
      }
      continue
    }

    await args.db
      .from('users')
      .update({ status: 'closed', closed_at: args.now.toISOString() })
      .eq('id', row.user_id as string)
      .is('closed_at', null)

    await writeAudit({
      actorUserId: null,
      actorRole: 'system',
      action: 'account.retired_dormant',
      targetType: 'user',
      targetId: row.user_id as string,
      reasonCode: 'dormant',
      // No deletion_requested_at: nobody asked. The distinction matters if
      // somebody later asks why their account is gone.
      after: { last_active_at: row.last_active_at, after_days: rule.days },
    })

    await deIdentifyAccount({ db: args.db, userId: row.user_id as string, now: args.now })
    retired += 1
  }

  return { warned, retired, blocked }
}

/** Tells somebody their account is about to be retired. Once. */
async function warnOfDormancy(args: { db: Db; userId: string; now: Date }): Promise<boolean> {
  const { data: user } = await args.db
    .from('users')
    .select('email')
    .eq('id', args.userId)
    .maybeSingle()

  if (!user?.email) return false

  const sent = await enqueueNotification({
    db: args.db,
    recipientUserId: args.userId,
    now: args.now,
    // Keyed on the account, not the date, so the daily run does not send
    // this every day for the thirty days it is inside the window.
    idempotencyKey: `dormancy_warning:${args.userId}`,
    draft: {
      kind: 'account.dormancy_warning',
      channel: 'email',
      destination: user.email,
      subject: 'Your Count On Local account is about to close',
      preview: `We have not seen any activity for a long time, so this account will close in ${DORMANCY_WARNING_DAYS} days. Sign in to keep it.`,
      payload: { warningDays: DORMANCY_WARNING_DAYS },
    },
  })
  return Boolean(sent)
}

/**
 * Photographs, and the bytes behind them.
 *
 * The storage object goes first. A row with no object is a broken link;
 * an object with no row is a photograph of somebody's house that nothing
 * in the database knows about and no sweep will ever visit again.
 */
async function expirePhotos(args: { db: Db; now: Date }): Promise<number> {
  const cutoff = cutoffFor({ rule: RETENTION.completion_photo, now: args.now })

  const { data, error } = await args.db
    .from('completion_photos')
    .select('id, storage_path')
    .lt('created_at', cutoff.toISOString())
    .limit(BATCH)

  if (error) throw new Error(error.message)
  const rows = data ?? []
  if (rows.length === 0) return 0

  const { error: removeError } = await args.db.storage
    .from(PHOTO_BUCKET)
    .remove(rows.map((r) => r.storage_path))

  // Deliberately fatal for this class: deleting the rows anyway would
  // orphan the objects permanently, and an orphan is exactly the thing
  // nothing will ever come back for.
  if (removeError) throw new Error(`storage remove failed: ${removeError.message}`)

  const { error: deleteError } = await args.db
    .from('completion_photos')
    .delete()
    .in(
      'id',
      rows.map((r) => r.id),
    )

  if (deleteError) throw new Error(deleteError.message)
  return rows.length
}

/**
 * Sent notifications.
 *
 * The sensitive part is `destination` -- an email address or a phone
 * number -- so the row goes rather than being blanked. Nothing references
 * notifications, so this is one of only two classes that can actually be
 * deleted.
 */
async function expireNotifications(args: { db: Db; now: Date }): Promise<number> {
  const cutoff = cutoffFor({ rule: RETENTION.notification, now: args.now })

  const { data, error } = await args.db
    .from('notifications')
    .select('id, state')
    .lt('created_at', cutoff.toISOString())
    .limit(BATCH)

  if (error) throw new Error(error.message)
  const rows = data ?? []
  if (rows.length === 0) return 0

  // A row three months old that is still pending, sending or failed means
  // the dispatcher stopped draining the outbox. It is deleted like the
  // rest -- a retention period that quietly does not apply to some rows is
  // not a retention period -- but it is reported first, loudly, because
  // tidying away the evidence of a broken job is how a broken job stays
  // broken.
  const stuck = rows.filter((r) => ['pending', 'sending', 'failed'].includes(r.state))
  if (stuck.length > 0) {
    console.error(
      `[retention] deleting ${stuck.length} notification(s) that were still queued after ${RETENTION.notification.days} days. The outbox is not draining.`,
    )
  }

  const { error: deleteError } = await args.db
    .from('notifications')
    .delete()
    .in(
      'id',
      rows.map((r) => r.id),
    )
  if (deleteError) throw new Error(deleteError.message)
  return rows.length
}

/**
 * Addresses nothing uses any more.
 *
 * Emptied rather than deleted: `subscriptions.service_address_id` is
 * `on delete restrict` and a subscription is kept for years, so the row
 * has to survive to hold the key. What goes is everything that identifies
 * the house -- the street, the postcode, the gate code, and the point on
 * the map, which is the one people forget.
 *
 * The clock comes from address_retention_clock (migration 0035), which is
 * NULL while any live subscription still uses the address. A view rather
 * than a column so no write path can forget to maintain it.
 */
async function expireAddresses(args: { db: Db; now: Date }): Promise<number> {
  const cutoff = cutoffFor({ rule: RETENTION.customer_address, now: args.now })

  const { data, error } = await args.db
    .from('address_retention_clock')
    .select('address_id')
    .not('clock_starts_at', 'is', null)
    .lt('clock_starts_at', cutoff.toISOString())
    .limit(BATCH)

  if (error) throw new Error(error.message)
  const ids = (data ?? []).map((r) => r.address_id as string)
  if (ids.length === 0) return 0

  return redactAddresses(args.db, ids)
}

/**
 * Empty a set of addresses, coordinates included.
 *
 * Through a function rather than a PostgREST update because
 * customer_addresses.point is a geography column and PostgREST cannot
 * write one -- 0018 needed a function to put the point in and 0037 needs
 * one to take it out. Clearing the street while leaving the coordinates
 * would be theatre: the point is a more precise address than the text.
 *
 * The function is idempotent, so a row already cleared is not counted or
 * rewritten.
 */
async function redactAddresses(db: Db, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0
  const { data, error } = await db.rpc('redact_customer_addresses' as never, {
    p_ids: ids,
  } as never)
  if (error) throw new Error(error.message)
  return (data as number | null) ?? 0
}

/**
 * Signatures past their retention period.
 *
 * This will find nothing for seven years, which is precisely why it is
 * written now and exercised by a test that fabricates an expired record.
 * A sweep first written in 2033 is a sweep first debugged in 2033, against
 * the oldest and least reconstructable rows in the database.
 *
 * What goes: the typed signature, the user agent, the hashed IP. What
 * stays, and cannot be touched by anyone: the document, its hash, the
 * version, which items were acknowledged, when, and by which account.
 *
 * The database enforces the timing independently (migrations 0035 and
 * 0036) -- it refuses a redaction inside the retention period, or while
 * the guardian relationship is still in force, even from the service role
 * this job runs as. The query below and the trigger have to agree, and if
 * they ever stop agreeing the trigger wins and this reports a failure
 * rather than quietly redacting something early.
 */
async function expireConsentRecords(args: { db: Db; now: Date }): Promise<number> {
  const cutoff = cutoffFor({ rule: RETENTION.consent_record, now: args.now })

  // Signed long enough ago to be a candidate. The trigger applies the
  // relationship-ended half of the clock, so this only has to be a
  // superset -- a record it offers up too early is refused, loudly.
  const { data, error } = await args.db
    .from('consent_records')
    .select('id')
    .lt('signed_at', cutoff.toISOString())
    .neq('typed_name', REDACTED)
    .limit(BATCH)

  if (error) throw new Error(error.message)
  const rows = data ?? []
  if (rows.length === 0) return 0

  let redacted = 0
  for (const row of rows) {
    // One at a time, because a single batched UPDATE would be rolled back
    // in its entirety by one row the trigger refuses -- and refusals are
    // expected here, not exceptional.
    const { error: updateError } = await args.db
      .from('consent_records')
      .update({ typed_name: REDACTED, user_agent: null, ip_hash: null })
      .eq('id', row.id)

    if (!updateError) {
      redacted += 1
      continue
    }
    // "Still in force" and "inside its period" are the trigger doing its
    // job. Anything else is a real problem and must not be swallowed.
    if (!/retention period|still in force/.test(updateError.message)) {
      throw new Error(updateError.message)
    }
  }
  return redacted
}

/**
 * Closed accounts that have not been de-identified yet.
 *
 * Separate from closeAccount so a closure whose de-identification failed
 * halfway is finished by the next run rather than left forever. That is
 * what users.de_identified_at is for: closed_at records the request,
 * de_identified_at records the work.
 */
async function deIdentifyClosedAccounts(args: { db: Db; now: Date }): Promise<number> {
  const { data, error } = await args.db
    .from('users')
    .select('id')
    .not('closed_at', 'is', null)
    .is('de_identified_at', null)
    .limit(BATCH)

  if (error) throw new Error(error.message)

  let done = 0
  for (const row of data ?? []) {
    try {
      await deIdentifyAccount({ db: args.db, userId: row.id, now: args.now })
      done += 1
    } catch (err) {
      console.error('[retention] de-identify failed', row.id, err)
    }
  }
  return done
}

export type CloseAccountResult =
  | { ok: true; effect: ReturnType<typeof deletionEffect> }
  | { ok: false; code: 'NOT_FOUND' | 'HAS_LIVE_SUBSCRIPTION' | 'OWED_MONEY'; message: string }

/**
 * Somebody asked to be deleted.
 *
 * ## Two refusals, both of which protect the person asking
 *
 * A live subscription is refused because closing an account with one
 * running would leave a customer charged for a service nobody is
 * scheduled to perform, or a provider with visits booked that they no
 * longer have an account to see. Cancel first, then close.
 *
 * An unpaid balance is refused because it is the person's own money.
 * Closing over the top of it would strand earnings in a ledger belonging
 * to an account that can no longer be contacted -- and for a provider
 * aged 13 to 17 that is a minor's money, held in a guardian's account,
 * which is the last thing that should quietly disappear.
 *
 * Neither refusal is a policy decision anybody has signed off. They are
 * the safe default, they are reversible by the person doing the cancelling
 * or the payout, and counsel should be told they exist in case a deletion
 * right somewhere requires closure regardless -- in which case the answer
 * is to pay out and cancel first, not to remove the check.
 */
export async function closeAccount(args: {
  db: Db
  userId: string
  /** Who asked. The account holder, or staff acting on their request. */
  actorUserId: string
  actorRole: string
  reason: string
  now: Date
  /** Hashed by writeAudit, never stored raw. */
  ip?: string | undefined
}): Promise<CloseAccountResult> {
  const { data: user, error } = await args.db
    .from('users')
    .select('id, status, closed_at')
    .eq('id', args.userId)
    .maybeSingle()

  if (error) throw new Error(error.message)
  if (!user) return { ok: false, code: 'NOT_FOUND', message: 'No such account.' }

  if (!user.closed_at) {
    const { count: liveSubscriptions } = await args.db
      .from('subscriptions')
      .select('id', { count: 'exact', head: true })
      .eq('customer_user_id', args.userId)
      .in('state', ['pending', 'active', 'paused', 'payment_failed'])

    if ((liveSubscriptions ?? 0) > 0) {
      return {
        ok: false,
        code: 'HAS_LIVE_SUBSCRIPTION',
        message:
          'Cancel your subscriptions before closing your account, so nothing is charged for work nobody is scheduled to do.',
      }
    }

    const owed = await amountOwed(args.db, args.userId)
    if (owed > 0) {
      return {
        ok: false,
        code: 'OWED_MONEY',
        message: `There is $${(owed / 100).toFixed(2)} still to be paid out. That money is yours — it needs to reach your payout account before the account can be closed.`,
      }
    }

    const { error: closeError } = await args.db
      .from('users')
      .update({
        status: 'closed',
        closed_at: args.now.toISOString(),
        deletion_requested_at: args.now.toISOString(),
      })
      .eq('id', args.userId)

    if (closeError) throw new Error(closeError.message)

    await writeAudit({
      actorUserId: args.actorUserId,
      actorRole: args.actorRole,
      action: 'account.closed',
      targetType: 'user',
      targetId: args.userId,
      reasonCode: 'deletion_requested',
      after: { reason: args.reason },
      ...(args.ip === undefined ? {} : { ip: args.ip }),
    })
  }

  await deIdentifyAccount({ db: args.db, userId: args.userId, now: args.now })

  // Returned so the page that confirms closure and the job that performs
  // it describe the same thing. Telling somebody their data is gone while
  // seven years of it is retained is the one outcome this must not have.
  return { ok: true, effect: deletionEffect() }
}

/** What the platform still owes this provider, in cents. */
async function amountOwed(db: Db, userId: string): Promise<number> {
  const { data } = await db
    .from('ledger_entries')
    .select('kind, amount_cents')
    .eq('provider_user_id', userId)

  return providerBalanceCents(
    (data ?? []).map((e) => ({
      kind: e.kind,
      amountCents: e.amount_cents,
      currency: 'USD',
    })) as never,
  )
}

/**
 * Replace everything on and around the account row that names a person.
 *
 * Idempotent: every write is an assignment to a fixed value, so running it
 * twice changes nothing the second time. That matters because the sweep
 * retries anything left unfinished.
 */
async function deIdentifyAccount(args: { db: Db; userId: string; now: Date }): Promise<void> {
  const { erasedNow } = deletionEffect()

  // users requires an email or a phone and both are unique, so neither can
  // simply be nulled. The tombstone is unique per account and lives at a
  // TLD reserved by RFC 2606 so it can never be delivered anywhere.
  const { error } = await args.db
    .from('users')
    .update({
      email: tombstoneEmail(args.userId),
      phone_e164: null,
      email_verified_at: null,
      phone_verified_at: null,
      de_identified_at: args.now.toISOString(),
    })
    .eq('id', args.userId)

  if (error) throw new Error(error.message)

  // The provider's display name is shown on a storefront and on reviews.
  // The date of birth is not touched: a NOT NULL column carrying two
  // schema constraints, and it is already never public and never sent to
  // analytics. Generalising it would satisfy nothing and risk breaking the
  // age constraints on a row nobody can repair afterwards.
  await args.db
    .from('provider_profiles')
    .update({ display_first_name: REDACTED })
    .eq('user_id', args.userId)
    .neq('display_first_name', REDACTED)

  if (erasedNow.includes('customer_address')) {
    const { data: addresses } = await args.db
      .from('customer_addresses')
      .select('id')
      .eq('customer_user_id', args.userId)

    await redactAddresses(
      args.db,
      (addresses ?? []).map((a) => a.id),
    )
  }

  if (erasedNow.includes('notification')) {
    await args.db.from('notifications').delete().eq('recipient_user_id', args.userId)
  }

  if (erasedNow.includes('message_ordinary')) {
    // Only the ordinary ones. A reported or blocked message is retained
    // whatever its sender asks, because otherwise the way to erase a
    // report about your conduct is to close your account.
    //
    // The other party loses their side of the conversation too. That is
    // unavoidable -- a message exists once, not once per reader -- and it
    // is the correct resolution: the person who wrote it asked for it to
    // go, and what survives is that a conversation happened.
    await args.db
      .from('messages')
      .update({ body: REDACTED, state: 'redacted' })
      .eq('sender_user_id', args.userId)
      .is('reported_at', null)
      .neq('state', 'blocked')
      .neq('state', 'redacted')
  }

  if (erasedNow.includes('completion_photo')) {
    // Objects before rows, for the reason given in expirePhotos: an
    // orphaned object is a photograph of somebody's house that no future
    // sweep will ever visit.
    const { data: photos } = await args.db
      .from('completion_photos')
      .select('id, storage_path')
      .eq('uploaded_by_user_id', args.userId)

    const rows = photos ?? []
    if (rows.length > 0) {
      const { error: removeError } = await args.db.storage
        .from(PHOTO_BUCKET)
        .remove(rows.map((r) => r.storage_path))
      if (removeError) throw new Error(`storage remove failed: ${removeError.message}`)

      const { error: deleteError } = await args.db
        .from('completion_photos')
        .delete()
        .in(
          'id',
          rows.map((r) => r.id),
        )
      if (deleteError) throw new Error(deleteError.message)
    }
  }

  await writeAudit({
    actorUserId: null,
    actorRole: 'system',
    action: 'account.de_identified',
    targetType: 'user',
    targetId: args.userId,
    // No snapshot of what was removed. An audit row containing the email
    // address we just erased would put it straight back, in a table kept
    // for seven years.
    after: { classes_erased: erasedNow },
  })
}
