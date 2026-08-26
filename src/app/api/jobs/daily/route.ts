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
 * ## Why the cadence is not daily
 *
 * "Daily" is a lie in a product with time zones. A run at 08:00 UTC is
 * already Tuesday in Chicago but still Monday evening in Honolulu, so a
 * single daily run leaves somebody's route unpromoted for hours -- and
 * which somebody depends on the hour chosen.
 *
 * Running every four hours means every zone gets promoted within four hours
 * of its own midnight, which for a route starting at 08:00 local is
 * comfortably early. The jobs are all idempotent, so the extra runs cost a
 * few queries and change nothing.
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
import { dispatchNotifications } from '@/server/notifications'
import { purgeExpiredMessages } from '@/server/messageService'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { apiError, apiOk, newRequestId } from '@/lib/http'

export const dynamic = 'force-dynamic'
/** Settlement talks to a payment processor; give it room. */
export const maxDuration = 300

type JobName = 'extend-horizon' | 'due-today' | 'settle' | 'notify' | 'purge-messages'

const JOBS: readonly JobName[] = ['extend-horizon', 'due-today', 'settle', 'notify', 'purge-messages']

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
  // Last, so anything the earlier jobs queued goes out in the same run
  // rather than waiting four hours.
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
