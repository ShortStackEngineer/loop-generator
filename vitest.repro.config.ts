import { defineConfig } from "vitest/config";

/** Run intentionally RED dog-food repro tests without pulling them into `npm test`. */
export default defineConfig({
  test: {
    include: ["test/repro/mock-structured-feedback-e2e.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
