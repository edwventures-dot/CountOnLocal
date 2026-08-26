/**
 * Pre-launch gate.
 *
 * The repository contains a mostly-built marketplace: subscription checkout,
 * payout onboarding, Stripe webhooks, provider storefronts. Deploying it so
 * the coming-soon page has a home would put all of that on the public
 * internet at the same time.
 *
 * That is not a code-quality worry -- steps 1 to 4 are tested and RLS is on.
 * It is that README lists five approvals the product does not have yet:
 * US legal review of marketplace terms and minor participation, insurance,
 * payment-processor sign-off on the final Connect setup, state-by-state
 * service restrictions, and trademark. Taking a real payment from a real
 * customer for work by a real 14-year-old before those clear is not a
 * technical mistake, it is a legal one.
 *
 * So until launch, exactly two things answer: the landing page and the
 * waitlist endpoint that page posts to. Everything else 404s.
 *
 * 404 rather than 403 on purpose. A 403 confirms the route exists, which
 * tells anyone probing what is being built and where the endpoints will be.
 * A 404 says nothing.
 *
 * TECHNICAL_SPEC section 19 asks for market-enablement and customer-
 * discovery flags. This is the blunt version of both, and it should be
 * replaced by real per-market flags when the first market opens rather than
 * being quietly switched off.
 */

/** Paths that answer while the gate is up. Exact matches only. */
export const PRELAUNCH_ALLOWED = new Set([
  '/',
  '/api/v1/waitlist',
  // The scheduler's entry point. Allowed through because it is protected by
  // a shared secret rather than by obscurity, and because 404ing it would
  // make every cron run look like a failure in the dashboard. During
  // pre-launch it has nothing to do -- there are no subscriptions -- so it
  // costs three empty queries.
  '/api/jobs/daily',
])

/**
 * Fail-closed in production.
 *
 * Unset means gated, because the failure modes are not symmetric: a gate
 * left up by mistake shows a coming-soon page to someone who wanted the
 * app, and a gate left down by mistake opens payments the lawyers have not
 * seen. Only an explicit PRELAUNCH=off lifts it.
 *
 * Development is open by default so `npm run dev` keeps working on the rest
 * of the product; set PRELAUNCH=on to rehearse the gate locally.
 */
export function prelaunchGateEnabled(env: {
  PRELAUNCH?: string | undefined
  NODE_ENV?: string | undefined
}): boolean {
  const flag = env.PRELAUNCH?.trim().toLowerCase()
  if (flag === 'on') return true
  if (flag === 'off') return false
  return env.NODE_ENV === 'production'
}

/**
 * Whether a request path may proceed.
 *
 * Compares the pathname only. Query strings cannot widen the allowlist, and
 * a trailing slash is normalised so /api/v1/waitlist/ cannot slip past a
 * set-membership check that /api/v1/waitlist would have failed.
 */
export function prelaunchAllows(pathname: string): boolean {
  if (PRELAUNCH_ALLOWED.has(pathname)) return true

  if (pathname.length > 1 && pathname.endsWith('/')) {
    return PRELAUNCH_ALLOWED.has(pathname.slice(0, -1))
  }

  return false
}
