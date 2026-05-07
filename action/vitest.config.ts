import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Fork tests live under tests/fork/**. They require an external RPC (or a
    // public fallback) and spawn an anvil child process; they're slow and opt-in
    // via `bun run test:fork` / `just action-test-fork`. Excluding them here
    // keeps the default `bun run test` suite fast and hermetic.
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/fork/**'],
  },
});
