import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Driver/agent runs and command evaluators can be slow; give them room.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
