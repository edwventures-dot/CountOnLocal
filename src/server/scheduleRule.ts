/**
 * Reading a stored schedule rule back into something typed.
 *
 * The rule is written as JSON by the business builder and read by the
 * occurrence generator, so it crosses a boundary where nothing checks it.
 * This is where it gets checked.
 *
 * It lived in checkoutService until that file was deleted with the rest of
 * the payment path. It was never about checkout -- the occurrence jobs
 * needed it too, and importing it from a module named for taking payments
 * was already the wrong shape.
 */

import { resolveTimeZone } from '@/domain/jurisdiction'
import type { ScheduleRule, Weekday } from '@/domain/schedule'

export function parseScheduleRule(raw: Record<string, unknown>): ScheduleRule | null {
  const freq = raw['frequency']
  const frequency =
    freq === 'weekly' || freq === 'every_2_weeks' || freq === 'every_4_weeks' ? freq : 'weekly'

  // Accept either a list of weekdays or the single `weekday` the earlier
  // builder wrote, so a service created before multi-day support still works.
  const list = Array.isArray(raw['weekdays'])
    ? (raw['weekdays'] as unknown[])
    : typeof raw['weekday'] === 'string'
      ? [raw['weekday']]
      : []

  const weekdays = list.filter((w): w is Weekday => typeof w === 'string') as Weekday[]
  if (weekdays.length === 0) return null

  return {
    frequency,
    weekdays,
    // Validated rather than trusted: this arrives from a browser. An
    // unrecognised zone falls back to Central, which is a last resort now
    // rather than the default it used to be.
    timezone: resolveTimeZone(typeof raw['timezone'] === 'string' ? raw['timezone'] : undefined),
    ...(typeof raw['windowStart'] === 'string' ? { windowStart: raw['windowStart'] } : {}),
    ...(typeof raw['windowEnd'] === 'string' ? { windowEnd: raw['windowEnd'] } : {}),
  }
}
