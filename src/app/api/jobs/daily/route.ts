/**
 * GET /api/jobs/daily
 *
 * The scheduler's entry point. Runs the background jobs TECHNICAL_SPEC
 * section 20 calls for, in a fixed order, and reports each one separately.
 *
 * ## One endpoint, not several
 *
 * Separate routes would give independent schedules, but Vercel's cheaper
 * plans cap the number of cron entries and these jobs want the same cadence
 * anyway. One endpoint also fixes the order, which matters twice: extending
 * the horizon before promoting means an occurrence generated this run can
 * be marked due in the same run, and dispatching notifications last means
 * anything the earlier jobs queued leaves immediately.
 *
 * A failure in one job does not stop the others. They are independent, and
 * a settlement that cannot reach Stripe should not also stop a provider
 * seeing today's route.
 *
 * Notification dispatch runs last, so anything the earlier jobs queued --
 * a cycle receipt, a failed-payment notice -- leaves in the same run
 * instead of waiting for the next one.
 *
 * ## The cadence, and what it costs
 *
 * "Daily" is a lie in a product with time zones. A run at 08:00 UTC is
 * already Tuesday in Chicago but still Monday evening in Honolulu, so the
 * hour chosen decides whose route is wrong.
 *
 * Four-hourly would fix that -- every zone promoted within four hours of
 * its own midnight -- and that is what vercel.json asked for until the
 * hosting plan turned out to be Hobby, which caps cron at one invocation a
 * day. So the schedule is 11:00 UTC, picked because it is past local
 * midnight in every US zone: 01:00 in Hawaii, 03:00 Pacific, 07:00 Eastern
 * at the worst end of daylight saving. Every route gets promoted before its
 * day starts, which is the property that actually matters.
 *
 * What the single run costs, stated rather than buried: notifications
 * dispatch once a day instead of six times, so a guardian invitation
 * queued just after a run waits until the next one. Nothing enqueues
 * notifications yet, so today that is theoretical -- but it stops being
 * theoretical the moment an email provider is wired, and at that point the
 * choice is a paid plan, an external scheduler hitting this endpoint with
 * the same secret, or accepting the delay.
 *
 * The jobs are all idempotent, so a more frequent schedule can be restored
 * by editing one line and costs only a few queries.
 *
 * ## Authentication
 *
 * A shared secret in the Authorization header, compared in constant time.
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET` automatically when
 * that variable is set on the project.
 *
 * With CRON_SECRET unset the endpoint refuses everything rather than
 * running open. An unauthenticated caller cannot make the platform charge
 * cards, and "the secret was not configured" is not a reason to let them.
 */

import { timingSafeEqual } from 'node:crypto'
import { extendHorizon, promoteDueToday } from '@/server/occurrenceJobs'
import { runSettlement } from '@/server/settlementService'
import { runReferralRewards } from '@/server/referralService'
import { runAgeOut } from '@/server/agingJob'
import { runPayouts } from '@/server/payoutService'
import { dispatchNotifications, setNotifier } from '@/server/notifications'
import { ResendNotifier, resendConfigFromEnv } from '@/server/resendNotifier'
import { purgeExpiredMessages } from '@/server/messageService'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { apiError, apiOk, newRequestId } from '@/lib/http'

export const dynamic = 'force-dynamic'
/** Settlement talks to a payment processor; give it room. */
export const maxDuration = 300

type JobName =
  | 'extend-horizon'
  | 'due-today'
  | 'settle'
  | 'pay-out'
  | 'age-out'
  | 'referral-rewards'
  | 'notify'
  | 'purge-messages'

const JOBS: readonly JobName[] = [
  'extend-horizon',
  'due-today',
  'settle',
  'pay-out',
  'age-out',
  'referral-rewards',
  'notify',
  'purge-messages',
]

function authorized(request: Request): boolean {
  const secret = process.env['CRON_SECRET']
  if (!secret) return false

  const header = request.headers.get('authorization') ?? ''
  const prefix = 'Bearer '
  if (!header.startsWith(prefix)) return false

  const provided = Buffer.from(header.slice(prefix.length))
  const expected = Buffer.from(secret)

  // timingSafeEqual throws on a length mismatch, which would itself leak
  // the length. Compare lengths first and always run the comparison.
  if (provided.length !== expected.length) return false
  return timingSafeEqual(provided, expected)
}

export async function GET(request: Request): Promise<Response> {
  const requestId = newRequestId()

  if (!authorized(request)) {
    // 404, not 401. An unauthenticated caller learns nothing about whether
    // this path exists.
    return new Response(null, { status: 404 })
  }

  const url = new URL(request.url)
  const only = url.searchParams.get('only') as JobName | null
  if (only && !JOBS.includes(only)) {
    return apiError('UNKNOWN_JOB', `Unknown job. Try one of: ${JOBS.join(', ')}.`, 400, {
      requestId,
    })
  }

  const db = supabaseAdmin()
  const now = new Date()
  const startedAt = now.toISOString()

  const results: Record<string, unknown> = {}
  const failures: Array<{ job: JobName; message: string }> = []

  async function run<T>(job: JobName, fn: () => Promise<T>): Promise<void> {
    if (only && only !== job) return
    try {
      results[job] = await fn()
    } catch (err) {
      // A thrown job is a bug, not an expected outcome -- the jobs report
      // their own soft failures in their result. Recorded and stepped over
      // so one broken job cannot take the other two down with it.
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[jobs] ${job} threw`, { requestId, message })
      failures.push({ job, message })
      results[job] = { threw: true }
    }
  }

  await run('extend-horizon', () => extendHorizon({ db, now }))
  await run('due-today', () => promoteDueToday({ db, now }))
  await run('settle', () => runSettlement({ db, now }))
  // After settlement, because qualifying reads the ledger for whether the
  // cycle was actually charged. Running it first would leave every referral
  // waiting an extra four hours for a charge that had already happened by
  // the time anyone looked.
  // Directly after settlement, which is what makes payout "immediate":
  // a provider is paid within one run of being credited. Separate from
  // settlement because it fails for different reasons -- most often a
  // platform balance that has not settled yet -- and must be retryable
  // without re-running the charge.
  await run('pay-out', () => runPayouts({ db, now }))
  // Before referrals and before notification dispatch, so a provider who
  // turned 18 overnight is an adult for everything that runs after it in
  // the same pass.
  await run('age-out', () => runAgeOut({ db, now }))
  await run('referral-rewards', () => runReferralRewards({ db, now }))
  // Last, so anything the earlier jobs queued goes out in the same run
  // rather than waiting four hours.
  // Installed here rather than at import time: this is the only place that
  // drains the outbox, and a sender constructed at module load would read
  // the environment before the runtime has finished providing it. With no
  // key configured this leaves UnconfiguredNotifier in place, which refuses
  // loudly rather than dropping mail silently.
  const emailConfig = resendConfigFromEnv(process.env)
  if (emailConfig) setNotifier(new ResendNotifier(emailConfig))

  await run('notify', () => dispatchNotifications({ db, now }))
  // PRD 17 requires the retention policy be implemented, not merely
  // documented. Bodies past their date are redacted; the row stays, so the
  // fact a conversation happened survives even though the words do not.
  await run('purge-messages', () => purgeExpiredMessages({ db, now }))

  const finishedAt = new Date().toISOString()

  // 200 even with failures inside, so the scheduler does not retry a run
  // that partly succeeded. The body carries what went wrong, and the logs
  // carry the detail. A 500 here would re-run settlement, which is safe but
  // pointlessly noisy.
  return apiOk({
    requestId,
    startedAt,
    finishedAt,
    ran: only ? [only] : JOBS,
    failures,
    results,
  })
}
