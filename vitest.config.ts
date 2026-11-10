import { defineConfig } from "vitest/config";

// EP-01.04 : couverture ≥ 90 % exigée sur le cœur d'analyse.
export default defineConfig({
  test: {
    // Cache des modules propre au paquet : partagé à la racine, il était vidé en même temps par
    // chaque Vitest lancé par turbo après un changement du pnpm-lock (ENOTEMPTY, 10/11/2026).
    fsModuleCachePath: "node_modules/.vitest-cache",
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
