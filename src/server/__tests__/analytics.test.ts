import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  NullSink,
  setAnalyticsSink,
  StubSink,
  track,
  type AnalyticsSink,
} from '../analytics'

let sink: StubSink

beforeEach(() => {
  sink = new StubSink()
  setAnalyticsSink(sink)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** track() does not await the sink, so tests have to let the microtask run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('track', () => {
  it('captures a well-formed event', async () => {
    track({
      event: 'subscription_started',
      properties: { subscription_id: 'sub_1', price_cents: 300 },
      userId: 'u_1',
    })
    await settle()

    expect(sink.captured).toHaveLength(1)
    expect(sink.captured[0]!.event).toBe('subscription_started')
    expect(sink.captured[0]!.properties).toEqual({ subscription_id: 'sub_1', price_cents: 300 })
  })

  it('scrubs before the sink ever sees the payload', async () => {
    // The scrub is not the vendor's job. By the time an envelope leaves
    // this process it is already clean.
    track({
      event: 'address_checked',
      properties: { line1: '742 Evergreen Terrace', postal_code: '78701', eligible: true },
    })
    await settle()

    expect(sink.captured[0]!.properties).toEqual({ eligible: true })
    expect(JSON.stringify(sink.captured)).not.toContain('Evergreen')
  })

  it('reports what it dropped so a caller can assert on it', () => {
    const r = track({ event: 'address_checked', properties: { line1: 'x', eligible: true } })
    expect(r.accepted).toBe(true)
    expect(r.dropped).toEqual(['line1'])
  })

  it('refuses an unknown event rather than sending it', async () => {
    const r = track({ event: 'vibes_measured' })
    await settle()

    expect(r.accepted).toBe(false)
    expect(sink.captured).toHaveLength(0)
  })
})

describe('a broken vendor cannot break a checkout', () => {
  it('does not throw when the sink throws', async () => {
    sink.failWith(new Error('vendor is down'))

    expect(() => track({ event: 'subscription_started' })).not.toThrow()
    await settle()
  })

  it('still reports the event as accepted, because acceptance is not delivery', () => {
    sink.failWith(new Error('vendor is down'))
    // track() returns before the network call. It cannot know, and says so
    // in its own docs rather than pretending.
    expect(track({ event: 'subscription_started' }).accepted).toBe(true)
  })

  it('leaves no unhandled rejection behind', async () => {
    sink.failWith(new Error('vendor is down'))
    track({ event: 'occurrence_completed' })

    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    await settle()
    process.off('unhandledRejection', unhandled)

    expect(unhandled).not.toHaveBeenCalled()
  })

  it('returns before the sink finishes', async () => {
    let released: (() => void) | undefined
    const slow: AnalyticsSink = {
      capture: () => new Promise<void>((resolve) => { released = resolve }),
    }
    setAnalyticsSink(slow)

    // If track() awaited, this line would not be reached until released().
    const r = track({ event: 'checkout_started' })
    expect(r.accepted).toBe(true)
    expect(released).toBeDefined()
    released!()
  })
})

describe('the unconfigured default', () => {
  it('drops without throwing', async () => {
    setAnalyticsSink(new NullSink())
    expect(() => track({ event: 'age_gate_passed' })).not.toThrow()
    await settle()
  })

  it('warns once, not on every event', async () => {
    const nullSink = new NullSink()
    setAnalyticsSink(nullSink)

    for (let i = 0; i < 50; i++) track({ event: 'age_gate_passed' })
    await settle()

    // An unconfigured vendor should be visible in a log, not a hundred
    // thousand lines of it.
    const analyticsWarnings = vi
      .mocked(console.warn)
      .mock.calls.filter((c) => String(c[0]).includes('No sink configured'))
    expect(analyticsWarnings).toHaveLength(1)
  })
})
