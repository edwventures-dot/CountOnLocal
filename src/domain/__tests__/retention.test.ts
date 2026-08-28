import { describe, expect, it } from 'vitest'
import {
  CHARGEBACK_WINDOW_DAYS,
  cutoffFor,
  deletionEffect,
  hasFiniteRetention,
  isExpired,
  REDACTED,
  RETENTION,
  sweptClasses,
  tombstoneEmail,
  type RetentionClass,
} from '../retention'
import { RETENTION_DAYS_FLAGGED, RETENTION_DAYS_ORDINARY } from '../messaging'

const ALL = Object.keys(RETENTION) as RetentionClass[]

describe('the shape of the policy, which is not a proposal', () => {
  it('gives every class a finite period', () => {
    // TECHNICAL_SPEC 23: "Do not invent indefinite retention by default."
    for (const c of ALL) {
      expect(hasFiniteRetention(RETENTION[c]), c).toBe(true)
    }
  })

  it('gives every class a stated reason and a stated clock', () => {
    // A number on its own is not reviewable. Counsel needs something to
    // disagree with.
    for (const c of ALL) {
      expect(RETENTION[c].reason.length, c).toBeGreaterThan(40)
      expect(RETENTION[c].clock.length, c).toBeGreaterThan(5)
    }
  })

  it('explains every refusal to erase on request', () => {
    // "We keep it" without "because" is the sentence a person is entitled
    // to argue with, so the policy is not allowed to omit it.
    for (const c of ALL) {
      if (RETENTION[c].onRequest === 'retain') {
        expect(RETENTION[c].retainedBecause, c).toBeTruthy()
      }
    }
  })

  it('keeps safety and financial records longer than ordinary ones', () => {
    // The one relationship the spec states outright.
    const ordinary = RETENTION.message_ordinary.days
    for (const c of ['ledger_entry', 'audit_log', 'incident', 'consent_record'] as const) {
      expect(RETENTION[c].days, c).toBeGreaterThan(ordinary)
    }
  })

  it('agrees with the message retention already built into messaging', () => {
    // Two places defining the same number is how the two drift apart.
    expect(RETENTION.message_ordinary.days).toBe(RETENTION_DAYS_ORDINARY)
    expect(RETENTION.message_flagged.days).toBe(RETENTION_DAYS_FLAGGED)
  })

  it('outlives the chargeback window for anything that evidences a visit', () => {
    // Evidence that expires first leaves the platform defending a dispute
    // with nothing in hand.
    for (const c of ['completion_photo', 'customer_address'] as const) {
      expect(RETENTION[c].days, c).toBeGreaterThan(CHARGEBACK_WINDOW_DAYS)
    }
  })
})

describe('what a deletion request actually does', () => {
  it('never erases the financial or safety record on request', () => {
    // A person asking to be forgotten cannot take the money with them, and
    // somebody who was reported must not be able to remove the report.
    const retained = deletionEffect().retained.map((r) => r.class)
    for (const c of ['ledger_entry', 'audit_log', 'incident', 'account_action'] as const) {
      expect(retained, c).toContain(c)
    }
  })

  it('never erases proof that a guardian consented', () => {
    expect(deletionEffect().retained.map((r) => r.class)).toContain('consent_record')
  })

  it('marks every class as either swept or covered by the account row', () => {
    // The failure this catches is the one this codebase has hit six times:
    // a capability declared in a policy that no code ever touches, with
    // nothing failing because absence is silent.
    const swept = sweptClasses()
    for (const c of ALL) {
      const viaAccount = RETENTION[c].mechanism === 'via_account'
      expect(swept.includes(c), c).toBe(!viaAccount)
    }
    expect(swept.length).toBeGreaterThan(0)
  })

  it('does not claim a sweep for records that only hold a user id', () => {
    // Nothing in a ledger entry names anybody. Listing it as swept would
    // describe work no code does.
    for (const c of ['ledger_entry', 'audit_log', 'incident', 'account_action'] as const) {
      expect(RETENTION[c].mechanism, c).toBe('via_account')
    }
  })

  it('does not promise to delete rows a foreign key will not let go', () => {
    // subscriptions.service_address_id is `on delete restrict` and a
    // subscription outlives the address by years. Promising deletion here
    // would be a policy the database refuses to honour.
    expect(RETENTION.customer_address.atExpiry).toBe('de_identify')
  })

  it('does not let closing an account erase a report about your conduct', () => {
    // The specific hole: ordinary messages go, flagged ones do not.
    const { erasedNow, retained } = deletionEffect()
    expect(erasedNow).toContain('message_ordinary')
    expect(retained.map((r) => r.class)).toContain('message_flagged')
  })

  it('does erase the things with no reason to survive', () => {
    const { erasedNow } = deletionEffect()
    for (const c of ['completion_photo', 'customer_address', 'notification'] as const) {
      expect(erasedNow, c).toContain(c)
    }
  })

  it('accounts for every class, with none left undecided', () => {
    const { erasedNow, retained } = deletionEffect()
    expect([...erasedNow, ...retained.map((r) => r.class)].sort()).toEqual([...ALL].sort())
  })

  it('gives a reason with every retained class, ready to show a person', () => {
    for (const r of deletionEffect().retained) {
      expect(r.because.length, r.class).toBeGreaterThan(20)
      expect(r.days, r.class).toBeGreaterThan(0)
    }
  })
})

describe('replacing rather than blanking', () => {
  it('marks a redacted field as removed rather than as absent', () => {
    // A blank reads as "we never had this". The truth is we had it and
    // took it out, and a reader years later should be able to tell those
    // apart.
    expect(REDACTED).toMatch(/removed/i)
  })

  it('gives a closed account an address that cannot receive mail', () => {
    // users requires an email or a phone and both are unique, so closure
    // cannot null them out. .invalid is reserved by RFC 2606 and can never
    // be registered.
    const email = tombstoneEmail('11111111-2222-3333-4444-555555555555')
    expect(email.endsWith('.invalid')).toBe(true)
    expect(email).not.toMatch(/@(gmail|countonlocal)/)
  })

  it('gives two closed accounts different addresses', () => {
    // A shared tombstone would collide on the unique index and the second
    // closure would fail.
    expect(tombstoneEmail('a')).not.toBe(tombstoneEmail('b'))
  })
})

describe('expiry', () => {
  const rule = RETENTION.notification
  const day = (n: number) => new Date(Date.UTC(2026, 0, 1 + n))

  it('is not expired before the period', () => {
    expect(isExpired({ clockStart: day(0), rule, now: day(rule.days - 1) })).toBe(false)
  })

  it('expires on the day', () => {
    expect(isExpired({ clockStart: day(0), rule, now: day(rule.days) })).toBe(true)
  })

  it('stays expired afterwards', () => {
    expect(isExpired({ clockStart: day(0), rule, now: day(rule.days + 500) })).toBe(true)
  })

  it('agrees with the cutoff the job queries by', () => {
    // The job selects rows older than cutoffFor rather than testing each
    // one, so the two must not disagree about the boundary.
    const now = day(1000)
    const cutoff = cutoffFor({ rule, now })
    expect(isExpired({ clockStart: cutoff, rule, now })).toBe(true)
    expect(isExpired({ clockStart: new Date(cutoff.getTime() + 1000), rule, now })).toBe(false)
  })
})
