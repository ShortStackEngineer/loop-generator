import { defineConfig } from "vitest/config";

/**
 * Run intentionally RED in-repo repro/acceptance tests without pulling them
 * into `npm test`. Keep `include` in sync with `vitest.config.ts` → `test.exclude`
 * (see loops/README.md). Add a path while baseline:strict; remove it once green.
 */
export default defineConfig({
  test: {
    include: [
      // Currently-RED stubs also listed in vitest.config.ts `test.exclude`.
      // (none — mock-structured-feedback-e2e is green; re-add paths as needed)
    ],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
