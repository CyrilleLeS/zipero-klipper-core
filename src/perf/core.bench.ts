// SPDX-License-Identifier: GPL-3.0-only
// Banc de mesure détaillé (EP-17.10) : `pnpm bench`. Chaque résultat est écrit en JSON dans
// `bench-results/` (artefact de CI, suivi d'une PR à l'autre). API des benchmarks de Vitest 5.
import { test } from "vitest";
import { parseConfig } from "../config/ini";
import { parseBedMeshOutput } from "../mesh/console";
import { computeMeshMetrics } from "../mesh/metrics";
import { parseMeshProfiles } from "../mesh/profiles";
import { parseProbeAccuracy } from "../probe/accuracy";
import { denseMeshConsole, largePrinterCfg, manyProbeSamples } from "./inputs.fixture";

const mesh5 = denseMeshConsole(5);
const mesh100 = denseMeshConsole(100);
const mesh400 = denseMeshConsole(400);
const cfg = largePrinterCfg(1000);
const probes = manyProbeSamples(10_000);
const parsed100 = parseBedMeshOutput(mesh100);
const grid100 = parsed100.ok ? parsed100.value[0]?.probed : undefined;

const out = (name: string) => ({ writeResult: `bench-results/${name}.json` });

test("maillage", async ({ bench }) => {
  await bench.compare(
    bench("BED_MESH_OUTPUT 5×5 (cas courant)", out("mesh-5"), () => void parseBedMeshOutput(mesh5)),
    bench("BED_MESH_OUTPUT 100×100 (sonde à balayage)", out("mesh-100"), () => {
      parseBedMeshOutput(mesh100);
    }),
    bench("BED_MESH_OUTPUT 400×400 (extrême)", out("mesh-400"), () => {
      parseBedMeshOutput(mesh400);
    }),
    bench("métriques 100×100", out("metrics-100"), () => {
      if (grid100) computeMeshMetrics(grid100);
    }),
  );
});

test("configuration et sonde", async ({ bench }) => {
  await bench.compare(
    bench("printer.cfg ≈ 22 000 lignes", out("config-22k"), () => void parseConfig(cfg)),
    bench("profils bed_mesh dans ce printer.cfg", out("profiles-22k"), () => {
      parseMeshProfiles(cfg);
    }),
    bench("PROBE_ACCURACY 10 000 mesures", out("probe-10k"), () => void parseProbeAccuracy(probes)),
  );
});
