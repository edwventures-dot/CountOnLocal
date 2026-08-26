/**
 * The analytics boundary.
 *
 * Same arrangement as the geocoder, the charger and the notifier: an
 * interface, a real implementation when one exists, a stub for tests, and a
 * setter. No vendor is chosen yet, so the default drops events.
 *
 * ## Why this default is the opposite of the notifier's
 *
 * `UnconfiguredNotifier` refuses loudly, because a notification that
 * silently vanishes leaves a guardian never asked and a provider believing
 * they were. Analytics has no such victim. Nobody is waiting on an event,
 * and the correct behaviour when there is no vendor is to do nothing and
 * carry on.
 *
 * So `NullSink` drops, and says so once at startup rather than on every
 * event -- an unconfigured analytics vendor should be visible in a log, not
 * a hundred thousand lines of it.
 *
 * ## track() never throws, and never blocks
 *
 * Two rules, both load-bearing:
 *
 *   - A vendor outage must not fail a checkout. Every error is caught here.
 *     The worst outcome of a broken sink is a gap in a funnel chart.
 *   - The caller does not await the network. An analytics call sitting in
 *     the middle of a subscription request would add a third party's
 *     latency to the customer's checkout, and a third party's downtime to
 *     ours.
 *
 * The consequence, stated plainly because it is a real limitation: events
 * can be lost on a crash or a serverless freeze. That is the deliberate
 * trade. If an event ever needs delivery guarantees it belongs in the
 * notification outbox or the ledger, not here -- those are the places built
 * to not lose things.
 */

import { buildEvent, type AnalyticsEnvelope } from '@/domain/analytics'

export interface AnalyticsSink {
  capture(envelope: AnalyticsEnvelope): Promise<void>
}

/**
 * What runs until a vendor is chosen.
 *
 * Warns once, then drops quietly.
 */
export class NullSink implements AnalyticsSink {
  private warned = false

  async capture(): Promise<void> {
    if (!this.warned) {
      this.warned = true
      console.warn(
        '[analytics] No sink configured; events are being dropped. Register one with setAnalyticsSink().',
      )
    }
  }
}

/** Records what it was asked to capture. */
export class StubSink implements AnalyticsSink {
  readonly captured: AnalyticsEnvelope[] = []
  private failure: Error | undefined

  /** Makes the next and all subsequent captures throw, to prove callers survive it. */
  failWith(error: Error | undefined): void {
    this.failure = error
  }

  async capture(envelope: AnalyticsEnvelope): Promise<void> {
    if (this.failure) throw this.failure
    this.captured.push(envelope)
  }

  reset(): void {
    this.captured.length = 0
    this.failure = undefined
  }
}

let current: AnalyticsSink | undefined

export function getAnalyticsSink(): AnalyticsSink {
  if (!current) current = new NullSink()
  return current
}

export function setAnalyticsSink(sink: AnalyticsSink): void {
  current = sink
}

/**
 * Records a funnel event.
 *
 * Fire and forget. Returns immediately; the promise it does not await is
 * handled internally so an unhandled rejection cannot take down the process.
 *
 * The return value says whether the event was accepted for sending, not
 * whether it arrived -- there is no way to know the latter without awaiting,
 * which is the thing this deliberately does not do. It is there so a caller
 * in a test can assert the event was well-formed.
 */
export function track(args: {
  event: unknown
  properties?: Record<string, unknown> | undefined
  userId?: string | undefined
}): { accepted: boolean; dropped: string[] } {
  const built = buildEvent(args)

  if (!built.ok) {
    // A bad event name is a programming error, not a runtime condition. Loud
    // in the log, silent to the caller.
    console.warn(`[analytics] ${built.message}`)
    return { accepted: false, dropped: [] }
  }

  if (built.dropped.length > 0) {
    // Worth seeing. Somebody spread an object into a payload, and the
    // allowlist caught it -- but the next payload might contain something
    // that has an allowed name and should not have been sent at all.
    console.warn(
      `[analytics] ${built.envelope.event}: dropped disallowed properties: ${built.dropped.join(', ')}`,
    )
  }

  void getAnalyticsSink()
    .capture(built.envelope)
    .catch((error: unknown) => {
      // A vendor outage is not worth failing a checkout over.
      console.warn(`[analytics] capture failed for ${built.envelope.event}:`, error)
    })

  return { accepted: true, dropped: built.dropped }
}
