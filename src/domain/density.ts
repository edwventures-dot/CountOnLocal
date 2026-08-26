/**
 * Route density, and what may be said about it in public.
 *
 * PRD section 14: the platform optimises for "revenue per local route, not
 * total map radius". Everything here serves that -- the metrics a provider
 * sees, the prompt that tells them to fill a route before widening it, and
 * the rule about what a stranger is allowed to learn from a storefront.
 *
 * ## The social proof rule is a privacy rule
 *
 * "Public social proof can say 'Popular nearby' or 'Serving 8 homes in this
 * area' only when privacy thresholds are met. Never expose which houses
 * subscribe."
 *
 * A count is not anonymous when it is small. "Serving 2 homes in Oak Ridge
 * on Tuesdays" plus a neighbour who knows their own street is close to
 * naming the other house, and a provider's route is visible from the
 * pavement. So below a threshold a storefront says nothing about how many
 * customers there are -- not a vague version, not a rounded one. Silence,
 * because a hedge like "a few homes" is still a claim about a number.
 *
 * ## The expansion prompt is a guardrail, not encouragement
 *
 * UX_UI_SPEC section 13: "Only appear when route has healthy capacity
 * utilization. Avoid encouraging geographic sprawl too early." A young
 * provider who widens their area before filling it ends up walking further
 * for the same money, which is the failure mode this whole system is shaped
 * to avoid. So the prompt to expand is the one that has to earn its place;
 * the prompt to fill in is the default.
 */

export type RouteDensity = {
  /** Customers actually being served on this route. */
  activeCustomers: number
  /** The provider's own cap. */
  capacity: number
  /** 0 to 1. Capped at 1 -- an over-full route is full, not 120% full. */
  utilization: number
  openSpots: number
}

export function routeDensity(args: {
  activeCustomers: number
  capacity: number
}): RouteDensity {
  const capacity = Math.max(0, Math.trunc(args.capacity))
  const active = Math.max(0, Math.trunc(args.activeCustomers))

  if (capacity === 0) {
    return { activeCustomers: active, capacity: 0, utilization: 0, openSpots: 0 }
  }

  return {
    activeCustomers: active,
    capacity,
    utilization: Math.min(1, active / capacity),
    openSpots: Math.max(0, capacity - active),
  }
}

/**
 * How full a route has to be before suggesting a wider area.
 *
 * Deliberately high. Below this the honest advice is always "fill what you
 * have", and a prompt that says otherwise costs a fourteen-year-old real
 * walking for no extra money.
 */
export const EXPANSION_UTILIZATION_THRESHOLD = 0.8

/** Below this a route is too new for the platform to have useful advice. */
export const MIN_CUSTOMERS_FOR_ADVICE = 1

export type GrowthPrompt = {
  code:
    | 'get_first_customer'
    | 'fill_the_route'
    | 'nearly_full'
    | 'consider_expanding'
    | 'no_capacity_set'
  headline: string
  detail: string
  /** What the button should do. */
  action: 'share' | 'flyer' | 'expand_area' | 'set_capacity'
}

/**
 * The one thing worth telling this provider right now.
 *
 * One prompt, not a list. A Grow screen with five suggestions is a screen
 * nobody acts on, and the whole point of the density system is that the
 * next step is usually obvious once somebody says it plainly.
 */
export function growthPrompt(args: {
  density: RouteDensity
  /** Public label for where the route is, e.g. "Oak Ridge". Never an address. */
  areaLabel?: string | undefined
}): GrowthPrompt {
  const { density } = args
  const where = args.areaLabel ? ` in ${args.areaLabel}` : ''

  if (density.capacity === 0) {
    return {
      code: 'no_capacity_set',
      headline: 'Set how many homes you can handle',
      detail:
        'Capacity is what stops you taking on more work than fits in an afternoon. You can change it whenever.',
      action: 'set_capacity',
    }
  }

  if (density.activeCustomers < MIN_CUSTOMERS_FOR_ADVICE) {
    return {
      code: 'get_first_customer',
      headline: 'Get your first customer',
      detail:
        'Share your page with someone on your street, or print a flyer for the houses you already walk past.',
      action: 'share',
    }
  }

  if (density.utilization >= 1) {
    return {
      code: 'nearly_full',
      headline: `Your route is full${where}`,
      detail:
        'Raise your capacity if you can genuinely fit more stops, or widen your area to keep growing.',
      action: 'expand_area',
    }
  }

  if (density.utilization >= EXPANSION_UTILIZATION_THRESHOLD) {
    return {
      code: 'consider_expanding',
      headline: `${density.openSpots} spot${density.openSpots === 1 ? '' : 's'} left${where}`,
      detail:
        'You are nearly full. Once these go, widening your area by a street or two is worth it.',
      action: 'flyer',
    }
  }

  // The default, and the one that matters most. Filling a route beats
  // widening it -- same money, less walking.
  return {
    code: 'fill_the_route',
    headline: `${density.activeCustomers} home${density.activeCustomers === 1 ? '' : 's'}${where}, ${density.openSpots} spot${density.openSpots === 1 ? '' : 's'} open`,
    detail:
      'Add more customers nearby before widening your area. A tighter route pays the same and takes less walking.',
    action: 'flyer',
  }
}

/**
 * Customers required before a storefront may mention how many there are.
 *
 * Five, because the risk is re-identification rather than embarrassment.
 * "Serving 2 homes in Oak Ridge on Tuesdays" plus a neighbour who knows
 * their own street is close to naming the other house, and a bin route is
 * visible from the pavement.
 */
export const MIN_CUSTOMERS_FOR_SOCIAL_PROOF = 5

export type SocialProof =
  | { show: true; label: string }
  | { show: false }

/**
 * What a public storefront may say about how busy this route is.
 *
 * Below the threshold: nothing. Not "a few homes", not "popular" -- a hedge
 * is still a claim about a number, and PRD section 14's "never expose which
 * houses subscribe" is not satisfied by being vague about a small one.
 */
export function socialProof(args: {
  activeCustomers: number
  areaLabel?: string | undefined
  minimum?: number | undefined
}): SocialProof {
  const minimum = args.minimum ?? MIN_CUSTOMERS_FOR_SOCIAL_PROOF
  if (args.activeCustomers < minimum) return { show: false }

  const where = args.areaLabel ? ` in ${args.areaLabel}` : ' in this area'
  return { show: true, label: `Serving ${args.activeCustomers} homes${where}` }
}

/**
 * Estimated earnings per hour on this route.
 *
 * PRD section 13 warns against the word "profit" while costs are not
 * tracked, so this is explicitly an earnings estimate. Returns null rather
 * than a made-up number when there is nothing to divide by -- a confident
 * "$0/hour" would be worse than an honest blank.
 */
export function earningsPerHourCents(args: {
  routeValueCents: number
  estimatedMinutes: number
}): number | null {
  if (args.estimatedMinutes <= 0) return null
  return Math.round((args.routeValueCents * 60) / args.estimatedMinutes)
}

/**
 * Referral code alphabet.
 *
 * No 0/O, no 1/I/L. These get read aloud across a fence and typed from a
 * flyer by someone holding a dog lead, and a code that cannot be
 * transcribed is worse than no code.
 */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
export const REFERRAL_CODE_LENGTH = 8

export function isReferralCode(v: unknown): v is string {
  if (typeof v !== 'string' || v.length !== REFERRAL_CODE_LENGTH) return false
  return [...v].every((c) => CODE_ALPHABET.includes(c))
}

/**
 * Builds a code from supplied random bytes.
 *
 * The randomness is passed in rather than read here so this stays pure and
 * a test can pin the output. Rejection is not needed: the alphabet is 31
 * characters and the modulo bias over 256 is small enough to be irrelevant
 * for a code whose only job is to be unguessable enough that nobody bothers.
 */
export function referralCodeFrom(bytes: Uint8Array): string {
  if (bytes.length < REFERRAL_CODE_LENGTH) {
    throw new RangeError(`Need at least ${REFERRAL_CODE_LENGTH} bytes`)
  }
  let out = ''
  for (let i = 0; i < REFERRAL_CODE_LENGTH; i++) {
    out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length]
  }
  return out
}

/**
 * Normalises what somebody typed off a flyer.
 *
 * Uppercases, then drops anything not in the alphabet -- spaces, dashes
 * somebody added for readability, and the characters deliberately excluded
 * from it. There is no O-for-0 substitution because neither character is
 * ever generated, so a typed O is a misreading of something else and
 * guessing which would be worse than failing the lookup honestly.
 */
export function normalizeReferralCode(input: string): string {
  return [...input.trim().toUpperCase()]
    .filter((c) => CODE_ALPHABET.includes(c))
    .join('')
    .slice(0, REFERRAL_CODE_LENGTH)
}
