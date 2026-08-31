/**
 * Carrying a checked address from the storefront into checkout.
 *
 * A customer types their address on the storefront to ask "do you cover my
 * house", is told yes, clicks through — and is asked for it again. Two
 * identical forms in a row, the second one for no reason they can see.
 *
 * ## Why not the URL
 *
 * The obvious fix is a query string, and it is the wrong one. A home
 * address in a URL is written to server access logs, kept in browser
 * history, and handed to any third party in a referrer header. For a
 * product whose service addresses are visible only to the customer, their
 * provider, a linked guardian and audited staff, putting one in a link
 * would undo that in the easiest place to overlook.
 *
 * sessionStorage stays in the tab. It is never transmitted, dies when the
 * tab closes, and is readable only by this origin.
 *
 * ## Why it is consumed rather than left
 *
 * Read once and removed. Left behind, a customer who checks one address,
 * wanders off, and comes back later to buy for a different house would
 * silently get the old one prefilled — and an address nobody re-read is
 * exactly the field somebody does not check before paying.
 */

export type HandoffAddress = {
  line1: string
  city: string
  region: string
  postalCode: string
}

const KEY = 'col.checkout.address'

/** Remembers an address that has just been confirmed as serviceable. */
export function stashAddress(providerServiceId: string, address: HandoffAddress): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ providerServiceId, address }))
  } catch {
    // Private browsing, a full quota, storage disabled. The customer types
    // it again, which is the behaviour this replaces -- never an error.
  }
}

/**
 * Takes the address back out, if it was stored for this same service.
 *
 * The service id is checked because a customer can have two storefronts
 * open. Prefilling the wrong service's address would be worse than asking.
 */
export function takeAddress(providerServiceId: string): HandoffAddress | null {
  try {
    const raw = sessionStorage.getItem(KEY)
    if (!raw) return null
    sessionStorage.removeItem(KEY)

    const parsed = JSON.parse(raw) as { providerServiceId?: string; address?: HandoffAddress }
    if (parsed.providerServiceId !== providerServiceId) return null

    const a = parsed.address
    if (!a?.line1 || !a.city || !a.region || !a.postalCode) return null
    return a
  } catch {
    return null
  }
}
