/**
 * Public slugs.
 *
 * A business slug becomes countonlocal.com/{slug}, printed on QR flyers and
 * pinned to doors. Once it is in the world it cannot practically change, so
 * the rules here are deliberately strict rather than forgiving.
 */

/** Slugs that collide with product routes or look official. Mirrors the reserved_slugs table. */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'www','api','app','admin','administrator','support','help',
  'about','legal','terms','privacy','safety','security',
  'login','logout','signin','signup','register','account',
  'settings','dashboard','payouts','billing','checkout',
  'guardian','guardians','provider','providers','customer',
  'customers','search','find','start','explore','blog',
  'press','careers','contact','status','countonlocal',
  'stripe','webhooks','static','assets','public','null',
  'undefined','me','new','edit','delete',
])

export const SLUG_MIN = 3
export const SLUG_MAX = 40

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

export type SlugRejection =
  | 'TOO_SHORT'
  | 'TOO_LONG'
  | 'INVALID_CHARACTERS'
  | 'RESERVED'
  | 'LOOKS_LIKE_A_UUID'

export type SlugCheck = { ok: true } | { ok: false; code: SlugRejection }

export function checkSlug(slug: string): SlugCheck {
  if (slug.length < SLUG_MIN) return { ok: false, code: 'TOO_SHORT' }
  if (slug.length > SLUG_MAX) return { ok: false, code: 'TOO_LONG' }
  if (!SLUG_PATTERN.test(slug)) return { ok: false, code: 'INVALID_CHARACTERS' }
  if (RESERVED_SLUGS.has(slug)) return { ok: false, code: 'RESERVED' }
  // A slug shaped like an id invites confusion with internal routes.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}/.test(slug)) return { ok: false, code: 'LOOKS_LIKE_A_UUID' }
  return { ok: true }
}

/**
 * Derives a candidate slug from a business name.
 *
 * Strips accents rather than dropping accented letters, so "Jorge's Yard
 * Café" becomes jorges-yard-cafe instead of jorges-yard-caf.
 */
export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '')
}

/**
 * Produces a slug that does not collide with any already taken.
 *
 * Suffixes with -2, -3 and so on rather than random characters: a provider
 * reads this aloud to neighbours, and "jakes-bin-service-2" survives that
 * where "jakes-bin-service-x7f2" does not.
 */
export function uniqueSlug(desired: string, taken: ReadonlySet<string>): string {
  const base = slugify(desired) || 'my-business'
  const fits = (s: string) => checkSlug(s).ok && !taken.has(s)

  if (fits(base)) return base

  for (let n = 2; n < 1000; n += 1) {
    const suffix = `-${n}`
    const trimmed = base.slice(0, SLUG_MAX - suffix.length).replace(/-+$/g, '')
    const candidate = `${trimmed}${suffix}`
    if (fits(candidate)) return candidate
  }

  throw new Error('Could not derive a free slug')
}
