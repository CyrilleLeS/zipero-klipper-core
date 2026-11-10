import { defineConfig } from "vitest/config";

// Budgets de performance (EP-17.10) : exécutés à part, SANS couverture (l'instrumentation fausse
// les temps) et hors des tâches parallèles de `pnpm test`. Lancés par le job « Banc de mesure ».
export default defineConfig({
  test: {
    // Cache des modules propre au paquet : partagé à la racine, il était vidé en même temps par
    // chaque Vitest lancé par turbo après un changement du pnpm-lock (ENOTEMPTY, 10/11/2026).
    fsModuleCachePath: "node_modules/.vitest-cache",
    include: ["src/perf/**/*.test.ts"],
    environment: "node",
  },
});
