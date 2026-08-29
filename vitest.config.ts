import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Custom `exclude` replaces vitest defaults — keep the stock ignores, then
    // list intentionally RED dog-food stubs so `npm test` / regression stays
    // green under baseline:strict. Sync with vitest.repro.config.ts `include`
    // (see loops/README.md). Remove a path once that stub goes green.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/cypress/**",
      "**/.{idea,git,cache,output,temp}/**",
      "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*",
      // RED dog-food stubs (also in vitest.repro.config.ts include):
    ],
    // Driver/agent runs and command evaluators can be slow; give them room.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: [
        // CLI wiring (commander/inquirer/process.exit) — exercised via the built
        // binary in smoke runs, not unit-coverable.
        "src/cli/**",
        // Barrel re-exports.
        "src/index.ts",
        "src/testing/index.ts",
        // Type-only modules (interfaces/type aliases — no executable code).
        "src/**/types.ts",
        "**/*.d.ts",
      ],
      thresholds: {
        lines: 85,
        functions: 85,
        statements: 85,
        branches: 80,
      },
    },
  },
});
