/**
 * Safety incidents, and the rules staff work under.
 *
 * SAFETY_TRUST_POLICY section 15 gives four severities and a list of things
 * the system must do. PRD section 24 adds the constraint that shapes this
 * module: "Admin actions require role permissions and reason capture for
 * high-impact actions such as suspensions, address access, refunds above
 * threshold, and guardian override."
 *
 * ## Reason capture is a refusal, not a prompt
 *
 * A reason field that can be left blank is decoration. The audit log exists
 * so that somebody -- a guardian, a regulator, a lawyer, the person it
 * happened to -- can reconstruct why a fourteen-year-old's account was
 * suspended eighteen months ago, and "" reconstructs nothing.
 *
 * So high-impact actions are refused without a reason of substance, and
 * "reason of substance" has a floor: a single character satisfies a
 * required field and satisfies nobody reading the log later.
 *
 * ## Severity drives urgency, not permission
 *
 * An S0 does not unlock powers an S3 lacks. It changes how fast somebody
 * has to look and who gets told. Tying capability to severity would give
 * whoever files the report the ability to escalate their own privileges by
 * choosing a number.
 */

export type IncidentSeverity = 'S0' | 'S1' | 'S2' | 'S3'

export const SEVERITIES: readonly IncidentSeverity[] = ['S0', 'S1', 'S2', 'S3']

export function isSeverity(v: unknown): v is IncidentSeverity {
  return typeof v === 'string' && (SEVERITIES as readonly string[]).includes(v)
}

/** What each severity means, in the words of SAFETY_TRUST_POLICY 15. */
export const SEVERITY_MEANING: Readonly<Record<IncidentSeverity, string>> = {
  S0: 'Immediate threat or emergency report',
  S1: 'Physical safety, harassment, credible threat, missing animal, serious property issue',
  S2: 'Repeated boundary violation, unsafe instruction, significant payment or fraud issue',
  S3: 'Ordinary quality or service dispute',
}

/**
 * How long before somebody must have looked.
 *
 * Minutes, not a priority label. "High priority" is a word; twenty minutes
 * is a commitment somebody can be held to, and a queue can be sorted by.
 */
export const RESPONSE_TARGET_MINUTES: Readonly<Record<IncidentSeverity, number>> = {
  S0: 20,
  S1: 60 * 4,
  S2: 60 * 24,
  S3: 60 * 72,
}

export type IncidentState = 'open' | 'investigating' | 'resolved' | 'closed'

type Edge = { from: IncidentState; to: IncidentState }

const EDGES: readonly Edge[] = [
  { from: 'open', to: 'investigating' },
  { from: 'open', to: 'resolved' },
  { from: 'investigating', to: 'resolved' },
  // Reopening is allowed from resolved. Somebody deciding an incident was
  // finished does not make it finished, and the person it happened to may
  // reasonably disagree.
  { from: 'resolved', to: 'investigating' },
  { from: 'resolved', to: 'closed' },
]

export function canMoveIncident(from: IncidentState, to: IncidentState): boolean {
  return EDGES.some((e) => e.from === from && e.to === to)
}

/**
 * Actions requiring a recorded reason before they happen.
 *
 * PRD section 24 names suspensions, address access, refunds above
 * threshold, and guardian override. The rest are here because they have the
 * same shape: irreversible or invisible to the person affected.
 */
export const HIGH_IMPACT_ACTIONS = [
  'account.suspend',
  'account.reinstate',
  'business.pause_admin',
  'business.unpause_admin',
  'address.read',
  'payout.hold',
  'payout.release',
  'refund.issue',
  'guardian.override',
  'review.remove',
  'message.redact',
  'incident.close',
] as const

export type AdminAction = (typeof HIGH_IMPACT_ACTIONS)[number]

export function isHighImpact(action: string): action is AdminAction {
  return (HIGH_IMPACT_ACTIONS as readonly string[]).includes(action)
}

/**
 * Shortest reason that is worth writing down.
 *
 * Twenty characters. Long enough that "spam", "abuse" and "." do not pass,
 * short enough that "Customer reported unsafe behaviour" does. The number
 * is arbitrary; having a floor at all is not.
 */
export const MIN_REASON_LENGTH = 20

export type ReasonCheck =
  | { ok: true; reason: string }
  | { ok: false; code: 'missing' | 'too_short' | 'too_long'; message: string }

export function checkReason(input: unknown, action: string): ReasonCheck {
  if (typeof input !== 'string' || !input.trim()) {
    return {
      ok: false,
      code: 'missing',
      message: `${action} needs a reason. It goes in the audit log and somebody may have to read it years from now.`,
    }
  }

  const reason = input.trim()

  if (reason.length < MIN_REASON_LENGTH) {
    return {
      ok: false,
      code: 'too_short',
      message: `Say a bit more -- at least ${MIN_REASON_LENGTH} characters. "${reason}" will not mean anything to whoever reads this later.`,
    }
  }
  if (reason.length > 1000) {
    return { ok: false, code: 'too_long', message: 'Keep the reason under 1000 characters.' }
  }

  return { ok: true, reason }
}

/**
 * Refunds above this need a reason and land in the audit log.
 *
 * CLAUDE.md rule 9 says "refunds/credits above threshold". Below it, a
 * refund is routine goodwill and requiring an essay for a $3 credit would
 * train staff to type "x" twenty times -- which is worse than no floor,
 * because it makes the log look complete while saying nothing.
 */
export const REFUND_REASON_THRESHOLD_CENTS = 2000

export function refundNeedsReason(amountCents: number): boolean {
  return amountCents >= REFUND_REASON_THRESHOLD_CENTS
}

/**
 * Should a guardian be told about this incident?
 *
 * SAFETY_TRUST_POLICY 15: "notify guardian when a minor provider is
 * involved and safe/legal to do so."
 *
 * The safe-and-legal caveat is why this returns a recommendation rather
 * than sending anything. The obvious case it exists for is an incident
 * where the guardian is the subject -- telling them would be telling the
 * person the report is about. A machine should not make that call, so this
 * flags it for a human instead of deciding.
 */
export type GuardianNotification =
  | { notify: true; urgency: 'immediate' | 'routine' }
  | { notify: false; reason: 'no_minor_involved' | 'needs_human_judgement' }

export function guardianNotificationFor(args: {
  severity: IncidentSeverity
  providerIsMinor: boolean
  /** True when the report concerns the guardian themselves. */
  guardianIsSubject: boolean
}): GuardianNotification {
  if (!args.providerIsMinor) return { notify: false, reason: 'no_minor_involved' }

  if (args.guardianIsSubject) {
    // Telling them would be telling the person the report is about.
    return { notify: false, reason: 'needs_human_judgement' }
  }

  return {
    notify: true,
    urgency: args.severity === 'S0' || args.severity === 'S1' ? 'immediate' : 'routine',
  }
}

/**
 * Does this incident justify stopping the business right now?
 *
 * A recommendation, deliberately. SAFETY_TRUST_POLICY 15 says the system
 * must "allow immediate account/business pause", not that it must perform
 * one -- an automatic pause on every S1 would let anybody take a
 * competitor's route down by filing a report.
 */
export function recommendsImmediatePause(severity: IncidentSeverity): boolean {
  return severity === 'S0' || severity === 'S1'
}

/** Incident categories, matching the shape of what gets reported. */
export const INCIDENT_CATEGORIES = [
  'physical_safety',
  'harassment_or_threat',
  'sexual_content_or_contact',
  'animal_safety',
  'property_damage',
  'unsafe_instruction',
  'prohibited_work_requested',
  'payment_or_fraud',
  'service_quality',
  'other',
] as const

export type IncidentCategory = (typeof INCIDENT_CATEGORIES)[number]

export function isIncidentCategory(v: unknown): v is IncidentCategory {
  return typeof v === 'string' && (INCIDENT_CATEGORIES as readonly string[]).includes(v)
}

/**
 * The severity a category starts at.
 *
 * A starting point a human can raise or lower, not a verdict. Someone in
 * distress should not have to pick the right number from a dropdown for
 * their report to be seen quickly.
 */
export function defaultSeverityFor(category: IncidentCategory): IncidentSeverity {
  switch (category) {
    case 'physical_safety':
    case 'sexual_content_or_contact':
      return 'S0'
    case 'harassment_or_threat':
    case 'animal_safety':
      return 'S1'
    case 'unsafe_instruction':
    case 'prohibited_work_requested':
    case 'payment_or_fraud':
    case 'property_damage':
      return 'S2'
    case 'service_quality':
    case 'other':
      return 'S3'
  }
}
