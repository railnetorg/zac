import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/fork/**/*.fork.test.ts'],
    // Forking + deploying Safe + Roles + executing scoping calls + member
    // calls comfortably fits in 60s per test on a warm fork; bump higher for
    // cold-start / slow public RPC.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Each test file owns its own anvil child; running them in sequence keeps
    // logs readable and avoids fighting over a single port.
    fileParallelism: false,
  },
});
