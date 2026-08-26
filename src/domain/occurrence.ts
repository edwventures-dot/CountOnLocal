/**
 * The service occurrence lifecycle.
 *
 * PRD section 11 gives the happy path and three alternate endings:
 *
 *   scheduled -> due_today -> started(optional) -> completed -> settled
 *   provider_skipped -> credited
 *   customer_skipped -> no service (credit depends on notice, see credit.ts)
 *   issue_reported -> resolved / refunded / settled
 *   canceled, for future occurrences after the subscription ends
 *
 * Two things this module refuses to do, both deliberate.
 *
 * It will not let a state change happen without naming who is doing it. A
 * provider skipping their own route and a customer skipping a visit look
 * identical in the database -- one row moving to a skipped state -- but they
 * are opposite events: one is the provider failing to deliver and owing a
 * credit, the other is the customer declining service they may still owe
 * for. Collapsing them into "skip" is how a provider ends up paying for a
 * customer's vacation.
 *
 * And it will not compute money. Whether a skip earns a credit is a pricing
 * question that depends on notice windows and service configuration, so it
 * lives in credit.ts. This module answers only "may this transition happen,
 * and who may cause it".
 */

export type OccurrenceState =
  | 'scheduled'
  | 'due_today'
  | 'started'
  | 'completed'
  | 'settled'
  | 'provider_skipped'
  | 'customer_skipped'
  | 'issue_reported'
  | 'credited'
  | 'canceled'

/**
 * Who is asking. Not a role in the permissions sense -- the caller has
 * already been authorised as the provider or the customer for this
 * subscription. This says which of them is acting, because the same
 * transition means different things depending on the answer.
 *
 * 'system' is a background job: the horizon extender, the daily due-today
 * sweep, cycle settlement. 'admin' is trust and safety resolving an
 * incident, which is the only actor that can move a terminal state.
 */
export type Actor = 'provider' | 'customer' | 'system' | 'admin'

export type Transition = {
  from: OccurrenceState
  to: OccurrenceState
  by: readonly Actor[]
  /** Why this edge exists, for the error message and for the reader. */
  note: string
}

/**
 * Every legal edge. Anything not listed here is refused.
 *
 * An allowlist rather than a set of forbidden edges: the failure mode of a
 * missing allow is a support ticket, and the failure mode of a missing deny
 * is a completed service being silently re-opened and re-credited.
 */
export const TRANSITIONS: readonly Transition[] = [
  {
    from: 'scheduled',
    to: 'due_today',
    by: ['system'],
    note: 'The daily sweep promotes occurrences whose service date has arrived.',
  },
  {
    from: 'due_today',
    to: 'started',
    by: ['provider'],
    note: 'Optional. Some providers tap start when they set off; many never do.',
  },
  {
    from: 'due_today',
    to: 'completed',
    by: ['provider'],
    note: 'The common path. Starting is optional, so completing directly is normal.',
  },
  {
    from: 'started',
    to: 'completed',
    by: ['provider'],
    note: 'Finished a route stop that was explicitly started.',
  },
  {
    from: 'completed',
    to: 'settled',
    by: ['system'],
    note: 'Cycle settlement. The provider earning is now on the ledger.',
  },

  // Provider could not deliver. Always the provider's cost -- see credit.ts.
  {
    from: 'scheduled',
    to: 'provider_skipped',
    by: ['provider'],
    note: 'Vacation block or a day the provider cannot run the route.',
  },
  {
    from: 'due_today',
    to: 'provider_skipped',
    by: ['provider'],
    note: 'Same, decided on the day.',
  },
  {
    from: 'started',
    to: 'provider_skipped',
    by: ['provider'],
    note: 'Set off, could not complete this stop. Still undelivered.',
  },

  // Customer declined service. Whether it is free depends on notice.
  {
    from: 'scheduled',
    to: 'customer_skipped',
    by: ['customer'],
    note: 'Customer paused this visit ahead of time.',
  },
  {
    from: 'due_today',
    to: 'customer_skipped',
    by: ['customer'],
    note: 'Late notice. Likely inside the cutoff, so likely still billed.',
  },

  {
    from: 'provider_skipped',
    to: 'credited',
    by: ['system'],
    note: 'The credit for an undelivered service has been written to the ledger.',
  },
  {
    from: 'customer_skipped',
    to: 'credited',
    by: ['system'],
    note: 'Customer skipped with enough notice, so the visit is not billed.',
  },

  // Something went wrong with work that was done.
  {
    from: 'completed',
    to: 'issue_reported',
    by: ['customer'],
    note: 'Customer reports a problem before the cycle settles.',
  },
  {
    from: 'settled',
    to: 'issue_reported',
    by: ['customer'],
    note: 'Reported after settlement. Resolution may mean a refund.',
  },
  {
    from: 'issue_reported',
    to: 'completed',
    by: ['admin'],
    note: 'Resolved in the provider favour: the work stands.',
  },
  {
    from: 'issue_reported',
    to: 'credited',
    by: ['admin'],
    note: 'Resolved in the customer favour: credit against the next cycle.',
  },
  {
    from: 'issue_reported',
    to: 'settled',
    by: ['admin'],
    note: 'Resolved with no money movement, after settlement.',
  },

  // Subscription ended. Future work is cancelled, not skipped: nobody
  // failed to deliver, so nobody owes anything.
  {
    from: 'scheduled',
    to: 'canceled',
    by: ['system'],
    note: 'Subscription canceled or paused; this future occurrence will not run.',
  },
  {
    from: 'due_today',
    to: 'canceled',
    by: ['system'],
    note: 'Canceled on the day, before any work happened.',
  },
]

/** States from which nothing further can happen without an incident report. */
export const TERMINAL_STATES: ReadonlySet<OccurrenceState> = new Set([
  'credited',
  'canceled',
])

/** Occurrences a provider should see on a route for a given day. */
export const ACTIONABLE_STATES: ReadonlySet<OccurrenceState> = new Set([
  'due_today',
  'started',
])

/** States where the service was delivered and is therefore billable. */
export const DELIVERED_STATES: ReadonlySet<OccurrenceState> = new Set([
  'completed',
  'settled',
])

export type TransitionResult =
  | { ok: true; to: OccurrenceState }
  | { ok: false; code: 'unknown_transition' | 'wrong_actor'; message: string }

function edgesFrom(from: OccurrenceState): Transition[] {
  return TRANSITIONS.filter((t) => t.from === from)
}

/**
 * May `actor` move an occurrence from `from` to `to`?
 *
 * Distinguishes "that is not a thing that can happen" from "that can happen
 * but not by you", because they need different handling upstream: the first
 * is a bug or a stale client, the second is a 403 with a real explanation.
 */
export function canTransition(args: {
  from: OccurrenceState
  to: OccurrenceState
  actor: Actor
}): TransitionResult {
  const { from, to, actor } = args

  const edge = TRANSITIONS.find((t) => t.from === from && t.to === to)
  if (!edge) {
    const options = edgesFrom(from).map((t) => t.to)
    return {
      ok: false,
      code: 'unknown_transition',
      message: options.length
        ? `Cannot move an occurrence from ${from} to ${to}. From ${from} the only moves are: ${options.join(', ')}.`
        : `An occurrence in ${from} is final and cannot move.`,
    }
  }

  if (!edge.by.includes(actor)) {
    return {
      ok: false,
      code: 'wrong_actor',
      message: `${from} to ${to} is done by ${edge.by.join(' or ')}, not ${actor}.`,
    }
  }

  return { ok: true, to }
}

/** Everything `actor` could do to an occurrence in `from`, for building UI. */
export function availableTransitions(from: OccurrenceState, actor: Actor): OccurrenceState[] {
  return edgesFrom(from)
    .filter((t) => t.by.includes(actor))
    .map((t) => t.to)
}

export function isTerminal(state: OccurrenceState): boolean {
  return TERMINAL_STATES.has(state)
}

/** Did the customer receive the service? Drives what is billable. */
export function wasDelivered(state: OccurrenceState): boolean {
  return DELIVERED_STATES.has(state)
}
