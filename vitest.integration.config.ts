import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(process.cwd(), 'src') },
  },
  test: {
    include: ['src/**/*.integration.test.ts'],
    // These talk to a real database over the network, and they create and
    // tear down auth users. Serial, with room to breathe.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
