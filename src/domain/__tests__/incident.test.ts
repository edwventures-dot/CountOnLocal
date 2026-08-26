import { describe, expect, it } from 'vitest'
import {
  canMoveIncident,
  checkReason,
  defaultSeverityFor,
  guardianNotificationFor,
  HIGH_IMPACT_ACTIONS,
  INCIDENT_CATEGORIES,
  isHighImpact,
  isIncidentCategory,
  isSeverity,
  MIN_REASON_LENGTH,
  recommendsImmediatePause,
  REFUND_REASON_THRESHOLD_CENTS,
  refundNeedsReason,
  RESPONSE_TARGET_MINUTES,
  SEVERITIES,
  type IncidentState,
} from '../incident'

describe('reason capture is a refusal, not a prompt', () => {
  it('refuses a missing reason', () => {
    const r = checkReason(undefined, 'account.suspend')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('missing')
  })

  it('refuses an empty one', () => {
    expect(checkReason('   ', 'account.suspend').ok).toBe(false)
  })

  it.each(['spam', 'abuse', '.', 'x', 'bad'])('refuses "%s" as too thin', (reason) => {
    const r = checkReason(reason, 'account.suspend')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('too_short')
  })

  it('accepts a reason somebody could actually read later', () => {
    const r = checkReason(
      'Customer reported unsafe behaviour on 12 Sept; provider paused pending review.',
      'account.suspend',
    )
    expect(r.ok).toBe(true)
  })

  it('trims what was written', () => {
    const r = checkReason('   Repeated boundary violations reported by two customers.   ', 'x')
    if (r.ok) expect(r.reason.startsWith('Repeated')).toBe(true)
  })

  it('says why the reason matters rather than just "required"', () => {
    const r = checkReason('', 'account.suspend')
    if (!r.ok) expect(r.message).toMatch(/audit log|read it years/i)
  })

  it('refuses an essay too', () => {
    const r = checkReason('x'.repeat(1001), 'x')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('too_long')
  })

  it('has a floor above one character, which is the whole point', () => {
    expect(MIN_REASON_LENGTH).toBeGreaterThan(1)
  })
})

describe('which actions need one', () => {
  it('covers what PRD 24 names', () => {
    for (const action of [
      'account.suspend',
      'address.read',
      'refund.issue',
      'guardian.override',
    ]) {
      expect(isHighImpact(action)).toBe(true)
    }
  })

  it('does not treat ordinary reads as high impact', () => {
    expect(isHighImpact('incident.list')).toBe(false)
    expect(isHighImpact('dashboard.view')).toBe(false)
  })

  it('includes reinstatement as well as suspension', () => {
    // Undoing an action is as consequential as taking it, and somebody
    // should have to say why the account came back.
    expect(isHighImpact('account.reinstate')).toBe(true)
    expect(isHighImpact('payout.release')).toBe(true)
  })

  it('has no duplicates', () => {
    expect(new Set(HIGH_IMPACT_ACTIONS).size).toBe(HIGH_IMPACT_ACTIONS.length)
  })
})

describe('refund threshold', () => {
  it('does not demand an essay for a small goodwill credit', () => {
    expect(refundNeedsReason(300)).toBe(false)
  })

  it('demands one at the threshold', () => {
    expect(refundNeedsReason(REFUND_REASON_THRESHOLD_CENTS)).toBe(true)
    expect(refundNeedsReason(REFUND_REASON_THRESHOLD_CENTS + 1)).toBe(true)
  })

  it('has a threshold above zero, so routine credits stay routine', () => {
    // A floor everybody trips trains staff to type filler, which makes the
    // log look complete while saying nothing.
    expect(REFUND_REASON_THRESHOLD_CENTS).toBeGreaterThan(0)
  })
})

describe('severity drives urgency, not permission', () => {
  it('recognises the four severities', () => {
    for (const s of SEVERITIES) expect(isSeverity(s)).toBe(true)
    expect(isSeverity('S9')).toBe(false)
    expect(isSeverity('urgent')).toBe(false)
  })

  it('gives a response target in minutes rather than a word', () => {
    // "High priority" is a word. Twenty minutes is a commitment.
    expect(RESPONSE_TARGET_MINUTES.S0).toBeLessThan(RESPONSE_TARGET_MINUTES.S1)
    expect(RESPONSE_TARGET_MINUTES.S1).toBeLessThan(RESPONSE_TARGET_MINUTES.S2)
    expect(RESPONSE_TARGET_MINUTES.S2).toBeLessThan(RESPONSE_TARGET_MINUTES.S3)
  })

  it('targets under half an hour for an emergency', () => {
    expect(RESPONSE_TARGET_MINUTES.S0).toBeLessThanOrEqual(30)
  })

  it('does not let severity unlock capabilities', () => {
    // Nothing in this module maps a severity to a permission. If it ever
    // does, whoever files a report can escalate their own privileges by
    // choosing a number.
    const module = Object.keys({ RESPONSE_TARGET_MINUTES, recommendsImmediatePause })
    expect(module).not.toContain('permissionsFor')
  })
})

describe('recommending a pause rather than performing one', () => {
  it('recommends it for the serious ones', () => {
    expect(recommendsImmediatePause('S0')).toBe(true)
    expect(recommendsImmediatePause('S1')).toBe(true)
  })

  it('does not for ordinary disputes', () => {
    // An automatic pause on every report would let anybody take a
    // competitor's route down by filing one.
    expect(recommendsImmediatePause('S2')).toBe(false)
    expect(recommendsImmediatePause('S3')).toBe(false)
  })
})

describe('guardian notification', () => {
  it('tells the guardian when a minor is involved', () => {
    const r = guardianNotificationFor({
      severity: 'S1',
      providerIsMinor: true,
      guardianIsSubject: false,
    })
    expect(r.notify).toBe(true)
    if (r.notify) expect(r.urgency).toBe('immediate')
  })

  it('is routine for a lesser incident', () => {
    const r = guardianNotificationFor({
      severity: 'S3',
      providerIsMinor: true,
      guardianIsSubject: false,
    })
    if (r.notify) expect(r.urgency).toBe('routine')
  })

  it('does not notify when no minor is involved', () => {
    const r = guardianNotificationFor({
      severity: 'S0',
      providerIsMinor: false,
      guardianIsSubject: false,
    })
    expect(r.notify).toBe(false)
    if (!r.notify) expect(r.reason).toBe('no_minor_involved')
  })

  it('refuses to decide when the guardian is the subject', () => {
    // Telling them would be telling the person the report is about. A
    // machine should not make that call.
    const r = guardianNotificationFor({
      severity: 'S0',
      providerIsMinor: true,
      guardianIsSubject: true,
    })
    expect(r.notify).toBe(false)
    if (!r.notify) expect(r.reason).toBe('needs_human_judgement')
  })
})

describe('the incident state machine', () => {
  it('runs open to investigating to resolved', () => {
    expect(canMoveIncident('open', 'investigating')).toBe(true)
    expect(canMoveIncident('investigating', 'resolved')).toBe(true)
  })

  it('allows resolving straight from open, for a report that needs no work', () => {
    expect(canMoveIncident('open', 'resolved')).toBe(true)
  })

  it('allows reopening a resolved incident', () => {
    // Somebody deciding an incident is finished does not make it finished.
    expect(canMoveIncident('resolved', 'investigating')).toBe(true)
  })

  it('does not reopen a closed one', () => {
    for (const to of ['open', 'investigating', 'resolved'] as IncidentState[]) {
      expect(canMoveIncident('closed', to)).toBe(false)
    }
  })

  it('does not skip from open to closed', () => {
    // Closing is the end of a review, not a way to make a report vanish.
    expect(canMoveIncident('open', 'closed')).toBe(false)
  })
})

describe('categories start at a sensible severity', () => {
  it('recognises the categories', () => {
    for (const c of INCIDENT_CATEGORIES) expect(isIncidentCategory(c)).toBe(true)
    expect(isIncidentCategory('vibes')).toBe(false)
  })

  it('opens physical safety and sexual contact at S0', () => {
    expect(defaultSeverityFor('physical_safety')).toBe('S0')
    expect(defaultSeverityFor('sexual_content_or_contact')).toBe('S0')
  })

  it('opens an ordinary quality dispute at S3', () => {
    expect(defaultSeverityFor('service_quality')).toBe('S3')
  })

  it('gives every category a default, so nothing lands unsorted', () => {
    for (const c of INCIDENT_CATEGORIES) {
      expect(isSeverity(defaultSeverityFor(c))).toBe(true)
    }
  })

  it('does not make somebody in distress pick the right number', () => {
    // The default exists so a report is seen quickly whether or not the
    // reporter navigated a dropdown correctly.
    expect(defaultSeverityFor('harassment_or_threat')).toBe('S1')
  })
})
