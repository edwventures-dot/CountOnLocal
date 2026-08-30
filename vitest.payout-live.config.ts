import { defineConfig } from 'vitest/config'
import path from 'node:path'

/**
 * The one test that moves real money through real Stripe.
 *
 * Its own config for two reasons. It must never be picked up by the
 * ordinary integration run -- the file name deliberately does not end in
 * `.integration.test.ts` so it cannot be -- and RUN_LIVE_PAYOUT is set
 * here rather than on the command line, because `VAR=1 npm run ...` is a
 * POSIX shell idiom and this project is developed on Windows.
 */
export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(process.cwd(), 'src') },
  },
  test: {
    include: ['src/server/__tests__/payout.live.test.ts'],
    env: { RUN_LIVE_PAYOUT: '1' },
    fileParallelism: false,
    // Stripe onboarding, an account sync and two payout runs, over the
    // network, against a sandbox that is not always quick.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
