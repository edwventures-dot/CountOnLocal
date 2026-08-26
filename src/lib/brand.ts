/**
 * Brand tokens, mirroring assets/brand-tokens.css.
 *
 * The values live in one place because BRAND_GUIDE and README both note the
 * product may be forced to rename; centralising them is what makes that a
 * token edit rather than a redesign. Two other files still define these
 * inline (src/app/[slug]/page.tsx and AddressCheck.tsx) and should be
 * pointed here on their next edit.
 */

export const INK = '#14263A'
export const LIME = '#C7F34A'
export const CREAM = '#F6F3EA'
export const WHITE = '#FFFFFF'
export const CORAL = '#FF765C'
export const GREEN = '#16875B'
export const RED = '#C43E3E'
export const MUTED = '#607080'
export const BORDER = '#DDE3E6'

export const FONT_BODY = 'Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif'
export const FONT_HEADING = 'Manrope, ' + FONT_BODY

export const RADIUS_CARD = 18
export const RADIUS_CONTROL = 12
export const SHADOW = '0 12px 32px rgba(20, 38, 58, .08)'
