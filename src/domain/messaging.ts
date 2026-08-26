/**
 * What may be said in a message, and what happens when it may not be.
 *
 * PRD section 17: messaging is service-linked, contact and payment
 * circumvention is blocked "where practical", minors get stricter controls,
 * and either party can report. SAFETY_TRUST_POLICY section 9 adds that
 * automated systems may detect off-platform payment or contact exchange,
 * threats, sexual content, and prohibited work offers.
 *
 * ## Block, do not deliver-and-flag
 *
 * A flagged-but-delivered message has already done its work. If somebody
 * sends a fourteen-year-old a threat, the review queue is not the point --
 * the child not reading it is the point. So anything that trips a hard rule
 * is refused, the sender is told plainly, and the attempt is kept as
 * evidence rather than discarded.
 *
 * The cost of that choice is false positives, and the whole design of the
 * patterns below is shaped by keeping them rare. A messaging system that
 * refuses "I'll be there around 8" is one people route around by texting,
 * which loses the safety properties entirely.
 *
 * ## Why contact exchange is blocked at all
 *
 * Not to keep the platform's cut. Moving a fourteen-year-old's working
 * relationship into a private SMS thread removes the report button, the
 * audit trail, and the guardian's visibility all at once. Everything this
 * product does for a minor's safety depends on the conversation being
 * somewhere it can be seen.
 *
 * That is also why the refusal message says so, rather than citing terms.
 */

export type MessageVerdict = 'allow' | 'block'

export type ViolationCode =
  | 'phone_number'
  | 'email_address'
  | 'payment_app'
  | 'off_platform_payment'
  | 'social_handle'
  | 'threat'
  | 'sexual_content'
  | 'prohibited_work'

export type MessageCheck =
  | { verdict: 'allow' }
  | {
      verdict: 'block'
      code: ViolationCode
      /** Shown to the sender. Explains the reason, never quotes the match. */
      message: string
      /** Whether trust and safety should look now rather than in the queue. */
      urgent: boolean
    }

/**
 * A phone number a human would recognise as one.
 *
 * Seven or more digits with the separators people actually use. The
 * length floor is what keeps "$13.80", "8:00", "18 stops" and a date out of
 * it -- those are the numbers a service conversation is full of.
 */
const PHONE = /(\+?\d[\d\s().-]{7,}\d)/

/** Digits spelled out to dodge the check, e.g. "five five five one two". */
const SPELLED_DIGITS =
  /\b(zero|one|two|three|four|five|six|seven|eight|nine)(\W+(zero|one|two|three|four|five|six|seven|eight|nine)){5,}/i

const EMAIL = /[A-Za-z0-9._%+-]+\s*(@|\(at\)|\[at\]|\sat\s)\s*[A-Za-z0-9.-]+\s*(\.|\(dot\)|\sdot\s)\s*[A-Za-z]{2,}/i

/**
 * Payment apps by name.
 *
 * Word-bounded so "paypal" in "I use PayPal for everything" trips it -- that
 * is the point -- while ordinary words containing them do not.
 */
const PAYMENT_APP =
  /\b(venmo|cash\s?app|cashapp|zelle|paypal|apple\s?pay|google\s?pay|revolut|wise|western\s?union)\b/i

/** A Cash App $cashtag: a dollar sign followed by letters, not digits. */
const CASHTAG = /\$[A-Za-z][A-Za-z0-9_]{2,}/

/**
 * Arranging payment off the platform.
 *
 * Two deliberate choices, both about false positives.
 *
 * Past tense is excluded. "We paid the window cleaner in cash last week" is
 * a sentence somebody says, and it describes a completed act involving a
 * third party. This rule targets ARRANGING future off-platform payment, not
 * discussing past events, so `pay` is a trigger and `paid` is not. That
 * lets "I paid you in cash" through, which is a real gap and the right
 * trade -- the message worth stopping is the one that sets something up.
 *
 * And "cash" alone is innocent: "left them by the cash machine" is a
 * sentence too. It only counts beside a payment verb or in a fixed phrase.
 */
const OFF_PLATFORM_PAYMENT =
  /\b(pay|paying|pays)\b[^.!?\n]{0,40}\b(in\s+cash|cash\s+only|directly|direct|under\s+the\s+table)\b|\b(cash\s+only|under\s+the\s+table)\b|\b(just\s+)?(pay|give)\s+me\s+(the\s+)?cash\b/i

/**
 * Moving the conversation off the platform at all.
 *
 * Standalone, because the violation is the leaving rather than whatever is
 * arranged afterwards. "We can do this off the app" needs no payment verb
 * to be precisely the thing this ruleset exists to prevent: a minor's
 * working relationship in a private thread with no report button, no
 * record, and no guardian able to see it.
 */
const OFF_PLATFORM = /\b(off|outside)\s+(the\s+)?(app|platform|site)\b|\boff[- ]platform\b/i

const SOCIAL_HANDLE =
  /\b(instagram|insta|snapchat|snap|whatsapp|telegram|tiktok|facebook|messenger|discord)\b[^.!?\n]{0,30}\b(me|at|handle|dm|add|find)\b|\bdm\s+me\b|\badd\s+me\s+on\b/i

/**
 * Threats.
 *
 * Narrow on purpose. This has to catch a real threat aimed at a child
 * without catching "this weather is killing me" or "I killed it today",
 * which are things people say. So the trigger is a stated intention
 * directed at a person, not a violent word on its own.
 */
const THREAT =
  /\b(i('| a)?m\s+going\s+to|i'?ll|i\s+will|gonna)\b[^.!?\n]{0,30}\b(hurt|kill|beat|find|come\s+after|get)\b[^.!?\n]{0,20}\b(you|your|u)\b|\b(watch\s+your\s+back|you'?re\s+dead|i\s+know\s+where\s+you\s+live)\b/i

/**
 * Sexual content.
 *
 * Deliberately blunt and deliberately incomplete. A word list cannot make a
 * platform safe, and pretending otherwise would be worse than admitting the
 * limit: this catches the obvious, and the report button plus a human
 * handles what it does not. SAFETY_TRUST_POLICY section 9 gives safety
 * reports priority over ordinary support for exactly that reason.
 */
const SEXUAL =
  /\b(nude|nudes|naked|sexy|sext|horny|hookup|hook\s+up\s+with\s+me|send\s+pics|f[u*]ck\s+me)\b/i

/**
 * Work the catalog does not allow, offered directly in a message.
 *
 * PRD section 7's prohibited list, in the shape somebody would actually
 * phrase it. A provider cannot widen an approved service through free text
 * (CLAUDE.md rule 3), and a customer cannot widen it through a message
 * either.
 */
const PROHIBITED_WORK =
  /\b(babysit|babysitting|watch\s+my\s+(kid|kids|child|children|baby)|house\s?sit|housesitting|sleep\s?over|stay\s+overnight|drive\s+(me|my)|give\s+(me|us)\s+a\s+ride|ladder|roof|chainsaw|pesticide|weed\s?killer|inside\s+the\s+house|clean\s+inside)\b/i

/**
 * Rules that apply to everyone, in the order a message is checked.
 *
 * Safety first, so a message containing both a threat and a phone number is
 * reported as a threat -- the more serious fact, and the one that decides
 * how fast a human looks.
 */
const UNIVERSAL: Array<{
  code: ViolationCode
  pattern: RegExp
  urgent: boolean
  message: string
}> = [
  {
    code: 'threat',
    pattern: THREAT,
    urgent: true,
    message: 'This message cannot be sent. It has been reported.',
  },
  {
    code: 'sexual_content',
    pattern: SEXUAL,
    urgent: true,
    message: 'This message cannot be sent. It has been reported.',
  },
  {
    code: 'prohibited_work',
    pattern: PROHIBITED_WORK,
    urgent: false,
    message:
      'That kind of work is not something Count On Local covers, so it cannot be arranged here.',
  },
  {
    code: 'phone_number',
    pattern: PHONE,
    urgent: false,
    message:
      'Keep the conversation here rather than swapping numbers. It is what keeps the report button, the record of what was agreed, and a guardian able to see how things are going.',
  },
  {
    code: 'phone_number',
    pattern: SPELLED_DIGITS,
    urgent: false,
    message:
      'Keep the conversation here rather than swapping numbers. It is what keeps the report button, the record of what was agreed, and a guardian able to see how things are going.',
  },
  {
    code: 'email_address',
    pattern: EMAIL,
    urgent: false,
    message:
      'Keep the conversation here rather than swapping email addresses. It is what keeps the report button and the record of what was agreed.',
  },
  {
    code: 'social_handle',
    pattern: SOCIAL_HANDLE,
    urgent: false,
    message:
      'Messages need to stay on Count On Local. Moving somewhere else removes the report button and a guardian being able to see how things are going.',
  },
  {
    code: 'payment_app',
    pattern: PAYMENT_APP,
    urgent: false,
    message:
      'Payments run through Count On Local so the work is recorded and the money is protected. Arranging it elsewhere is not something we can support.',
  },
  {
    code: 'payment_app',
    pattern: CASHTAG,
    urgent: false,
    message:
      'Payments run through Count On Local so the work is recorded and the money is protected. Arranging it elsewhere is not something we can support.',
  },
  {
    code: 'off_platform_payment',
    pattern: OFF_PLATFORM,
    urgent: false,
    message:
      'Messages need to stay on Count On Local. Moving somewhere else removes the report button and a guardian being able to see how things are going.',
  },
  {
    code: 'off_platform_payment',
    pattern: OFF_PLATFORM_PAYMENT,
    urgent: false,
    message:
      'Payments run through Count On Local so the work is recorded and the money is protected. Arranging it elsewhere is not something we can support.',
  },
]

export const MAX_MESSAGE_LENGTH = 2000

export type MessageContext = {
  /** True when a minor is party to this thread. Tightens nothing yet, but
   * decides how loudly a violation is escalated. */
  involvesMinor: boolean
}

/**
 * Checks a message before it is sent.
 *
 * Returns the first violation rather than all of them: the sender needs one
 * clear reason, and listing everything wrong with a message reads as a
 * checklist to work around.
 */
export function checkMessage(body: string, context: MessageContext): MessageCheck {
  const text = body.trim()

  if (!text) {
    return {
      verdict: 'block',
      code: 'prohibited_work',
      message: 'Write something first.',
      urgent: false,
    }
  }

  for (const rule of UNIVERSAL) {
    if (rule.pattern.test(text)) {
      return {
        verdict: 'block',
        code: rule.code,
        message: rule.message,
        // A safety violation in a thread with a minor is escalated
        // immediately rather than queued. SAFETY_TRUST_POLICY section 9
        // gives safety reports priority over ordinary support.
        urgent: rule.urgent || (context.involvesMinor && isSafetyCode(rule.code)),
      }
    }
  }

  return { verdict: 'allow' }
}

function isSafetyCode(code: ViolationCode): boolean {
  return code === 'threat' || code === 'sexual_content' || code === 'prohibited_work'
}

export type LengthCheck = { ok: true; body: string } | { ok: false; message: string }

export function checkLength(body: string): LengthCheck {
  const trimmed = body.trim()
  if (!trimmed) return { ok: false, message: 'Write something first.' }
  if (trimmed.length > MAX_MESSAGE_LENGTH) {
    return { ok: false, message: `Keep it under ${MAX_MESSAGE_LENGTH} characters.` }
  }
  return { ok: true, body: trimmed }
}

/**
 * How long message bodies are kept.
 *
 * PRD section 17 requires a retention policy be documented and implemented.
 * TECHNICAL_SPEC section 23 adds that safety records may need longer than
 * ordinary ones and warns against inventing indefinite retention.
 *
 * So: ordinary conversation is pruned, and anything reported or blocked is
 * kept longer because it is evidence about a minor's safety and the people
 * who might need it are a guardian, trust and safety, or eventually
 * somebody outside the company.
 */
export const RETENTION_DAYS_ORDINARY = 365
export const RETENTION_DAYS_FLAGGED = 365 * 3

export function retentionDaysFor(args: { flagged: boolean }): number {
  return args.flagged ? RETENTION_DAYS_FLAGGED : RETENTION_DAYS_ORDINARY
}
