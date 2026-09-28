import { defineConfig } from "vitest/config";

// EP-01.04 : couverture ≥ 90 % exigée sur le cœur d'analyse.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Budgets de performance : à part (`pnpm test:perf`), sans instrumentation de couverture.
    exclude: ["src/perf/**"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.fixture.ts", "src/**/*.bench.ts"],
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
    },
  },
});
