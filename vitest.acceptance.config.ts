import { defineConfig } from "vitest/config";

/** Black-box checks of the built CLI; npm run test:acceptance builds first. */
export default defineConfig({
  test: {
    include: ["test/acceptance/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
