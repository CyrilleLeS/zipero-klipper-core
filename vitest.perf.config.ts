import { defineConfig } from "vitest/config";

// Budgets de performance (EP-17.10) : exécutés à part, SANS couverture (l'instrumentation fausse
// les temps) et hors des tâches parallèles de `pnpm test`. Lancés par le job « Banc de mesure ».
export default defineConfig({
  test: {
    include: ["src/perf/**/*.test.ts"],
    environment: "node",
  },
});
