/**
 * Sign-up credential rules.
 *
 * Pure, so the same check runs in the browser before submit and on the
 * server before the account is created. A rule that exists only in the form
 * is not a rule.
 *
 * ## Length and a blocklist, not composition rules
 *
 * No "must contain a symbol". Composition rules are well known to produce
 * worse passwords rather than better ones -- they push people to
 * Password1! and then to reusing it everywhere, and they punish the long
 * passphrase that is actually strong. NIST dropped them for that reason.
 *
 * So: a floor on length, a refusal of the handful of strings that are
 * guessed first, and a refusal of anything containing the person's own
 * email name, which is the single most common weak choice and the one an
 * attacker who knows the address tries first.
 *
 * The floor is 10 rather than Supabase's default 6. Six characters is
 * within brute-force range, and a meaningful share of the people signing up
 * here are thirteen and picking their first ever password on an account
 * that will eventually hold payout details.
 */

export const PASSWORD_MIN_LENGTH = 10

/**
 * Passwords common enough that a floor on length does not help.
 *
 * Deliberately short. A serious blocklist is tens of thousands of entries
 * and belongs in a service, not a constant -- this only catches what a
 * person types when they are not really choosing.
 */
const OBVIOUS: ReadonlySet<string> = new Set([
  'password',
  'password1',
  'password123',
  'passw0rd',
  '1234567890',
  '12345678901',
  'qwertyuiop',
  'qwerty123',
  'iloveyou1',
  'letmein123',
  'countonlocal',
  'administrator',
])

export type CredentialCheck = { ok: true } | { ok: false; message: string }

export function normalizeEmail(input: string): string {
  return input.trim().toLowerCase()
}

/**
 * Shape only. Whether the address exists is answered by whether the
 * confirmation email arrives, not by a regular expression -- every attempt
 * to decide deliverability with a pattern rejects somebody's real address.
 */
export function checkEmail(input: string): CredentialCheck {
  const email = normalizeEmail(input)

  if (email.length === 0) return { ok: false, message: 'Enter your email address.' }
  if (email.length > 254) return { ok: false, message: 'That email address is too long.' }

  const at = email.indexOf('@')
  const lastAt = email.lastIndexOf('@')
  if (at <= 0 || at !== lastAt || at === email.length - 1) {
    return { ok: false, message: 'Enter a complete email address.' }
  }
  if (/\s/.test(email)) return { ok: false, message: 'An email address cannot contain spaces.' }

  const domain = email.slice(at + 1)
  if (!domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) {
    return { ok: false, message: 'Enter a complete email address.' }
  }

  return { ok: true }
}

export function checkPassword(password: string, email?: string): CredentialCheck {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return {
      ok: false,
      message: `Use at least ${PASSWORD_MIN_LENGTH} characters. A few words together works well.`,
    }
  }

  // Supabase's own ceiling. Better to say so than to have the account
  // creation fail with a message written by somebody else.
  if (password.length > 72) {
    return { ok: false, message: 'That password is too long. Use 72 characters or fewer.' }
  }

  const lowered = password.toLowerCase()
  if (OBVIOUS.has(lowered)) {
    return { ok: false, message: 'That password is one of the first ones guessed. Pick another.' }
  }

  if (email) {
    const local = normalizeEmail(email).split('@')[0] ?? ''
    // Three characters is short enough to appear by chance; longer than
    // that inside a password is the person's own name.
    if (local.length >= 4 && lowered.includes(local)) {
      return { ok: false, message: 'Do not put your email name in your password.' }
    }
  }

  return { ok: true }
}

/** Both checks, email first, so the message names the field to fix. */
export function checkSignupCredentials(args: {
  email: string
  password: string
}): CredentialCheck {
  const email = checkEmail(args.email)
  if (!email.ok) return email
  return checkPassword(args.password, args.email)
}

/**
 * The one sentence a sign-up shows when it did not obviously succeed.
 *
 * Sign-in already refuses to distinguish a wrong password from an address
 * with no account, because doing so turns the form into a way to test
 * whether a given person has an account here -- and on a platform whose
 * users are frequently minors, "does this child have an account" is a
 * worse thing to leak than it would be elsewhere.
 *
 * Sign-up has the same hole and it is easier to miss, because the
 * processor's own message says the quiet part out loud: "User already
 * registered". So the raw message is never shown. An address that is
 * already taken produces the same sentence as a new address that needs
 * confirming, which is what makes the two indistinguishable from outside.
 *
 * Supabase obfuscates this itself when email confirmation is on, returning
 * a user with no identities rather than an error. With confirmation off it
 * returns the error instead -- so this handles both, and CONFIRMATION is
 * the message both collapse to.
 */
export const SIGNUP_CONFIRMATION_NOTICE =
  'Check your email for a link to confirm your address, then sign in.'

export type SignupOutcome =
  | { kind: 'confirm'; message: string }
  | { kind: 'retry'; message: string }

export function interpretSignupError(raw: string): SignupOutcome {
  const message = raw.toLowerCase()

  // Already taken. Never say so.
  if (message.includes('already registered') || message.includes('already been registered')) {
    return { kind: 'confirm', message: SIGNUP_CONFIRMATION_NOTICE }
  }

  if (message.includes('rate limit') || message.includes('too many')) {
    return {
      kind: 'retry',
      message: 'Too many attempts just now. Wait a minute and try again.',
    }
  }

  if (message.includes('invalid') && message.includes('email')) {
    return {
      kind: 'retry',
      message: 'That email address was not accepted. Check it and try again.',
    }
  }

  if (message.includes('password')) {
    return {
      kind: 'retry',
      message: `Choose a different password of at least ${PASSWORD_MIN_LENGTH} characters.`,
    }
  }

  // Anything else, including messages we have never seen. Showing the
  // processor's own wording is how the enumeration hole reopens the next
  // time they add an error case.
  return { kind: 'retry', message: 'We could not create that account. Please try again.' }
}
