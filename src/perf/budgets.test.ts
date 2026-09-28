// SPDX-License-Identifier: GPL-3.0-only
/**
 * Budgets de performance du cœur (EP-17.10, EP-17.03). Mesure médiane sur plusieurs passes ;
 * les budgets gardent une marge large (≈ 5× le temps mesuré sur un poste de développement) pour
 * rester fiables sur les machines de CI, tout en détectant une régression d'ordre de grandeur.
 * Le détail chiffré est produit par `pnpm bench` (artefact de CI).
 */
import { describe, expect, it } from "vitest";
import { parseConfig } from "../config/ini";
import { parseBedMeshOutput } from "../mesh/console";
import { computeMeshMetrics } from "../mesh/metrics";
import { parseProbeAccuracy } from "../probe/accuracy";
import { denseMeshConsole, largePrinterCfg, manyProbeSamples } from "./inputs.fixture";

function medianMs(run: () => unknown, passes = 5): number {
  const times: number[] = [];
  run(); // échauffement (compilation JIT)
  for (let i = 0; i < passes; i++) {
    const start = performance.now();
    run();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(passes / 2)] as number;
}

const mesh400 = denseMeshConsole(400);
const cfg = largePrinterCfg(1000); // ≈ 22 000 lignes
const probes = manyProbeSamples(10_000);

describe("budgets de performance", () => {
  it(`BED_MESH_OUTPUT 400×400 (${(mesh400.length / 1e6).toFixed(1)} Mo) : lecture < 400 ms`, () => {
    expect(medianMs(() => parseBedMeshOutput(mesh400))).toBeLessThan(400);
  });

  it("métriques d'un maillage 400×400 < 100 ms", () => {
    const parsed = parseBedMeshOutput(mesh400);
    if (!parsed.ok) throw new Error("échec inattendu");
    const grid = parsed.value[0]?.probed;
    if (!grid) throw new Error("grille absente");
    expect(medianMs(() => computeMeshMetrics(grid))).toBeLessThan(100);
  });

  it(`printer.cfg de ${cfg.split("\n").length} lignes : lecture < 250 ms`, () => {
    expect(medianMs(() => parseConfig(cfg))).toBeLessThan(250);
  });

  it("10 000 mesures de PROBE_ACCURACY < 150 ms", () => {
    expect(medianMs(() => parseProbeAccuracy(probes))).toBeLessThan(150);
  });
});
