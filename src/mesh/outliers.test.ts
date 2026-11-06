// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from "vitest";
import { findMeshOutliers, OUTLIER_MAX_COUNT, roundBedPadding } from "./outliers";
import { analyzeBedMesh } from "./report";
import type { MeshGrid } from "./types";

const grid = (values: number[][]): MeshGrid => ({
  rows: values.length,
  cols: values[0]?.length ?? 0,
  values,
});
/** Grille rows × cols définie par une fonction des indices. */
const surface = (rows: number, cols: number, z: (row: number, col: number) => number) =>
  grid(Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => z(r, c))));
const tilted = (r: number, c: number) => 0.03 * c - 0.02 * r;
const dome = (r: number, c: number) => -0.01 * ((r - 3) ** 2 + (c - 3) ** 2);
const NOISE = 0.05;

describe("points aberrants (EP-05.09)", () => {
  it("plan incliné ou dôme sans défaut : rien, même au bord", () => {
    expect(findMeshOutliers(surface(6, 6, tilted), NOISE)).toEqual([]);
    expect(findMeshOutliers(surface(7, 7, dome), NOISE)).toEqual([]);
  });

  it("une mesure isolée au milieu : elle seule, avec son écart", () => {
    const values = surface(6, 6, tilted).values.map((row) => [...row]);
    (values[2] as number[])[3] = (values[2]?.[3] as number) + 0.2;
    const found = findMeshOutliers(grid(values), NOISE);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ row: 2, col: 3 });
    expect(found[0]?.deviation).toBeCloseTo(0.2, 6);
  });

  it("dans un coin, et deux défauts éloignés", () => {
    const values = surface(7, 7, dome).values.map((row) => [...row]);
    (values[0] as number[])[0] = (values[0]?.[0] as number) - 0.3;
    (values[5] as number[])[4] = (values[5]?.[4] as number) + 0.15;
    const found = findMeshOutliers(grid(values), NOISE);
    expect(found.map((o) => [o.row, o.col])).toEqual([
      [0, 0],
      [5, 4],
    ]);
    expect(found[0]?.deviation).toBeLessThan(0);
  });

  it("écart sous le seuil de bruit : ignoré ; seuil plus bas : signalé", () => {
    const values = surface(6, 6, tilted).values.map((row) => [...row]);
    (values[3] as number[])[2] = (values[3]?.[2] as number) + 0.03;
    expect(findMeshOutliers(grid(values), NOISE)).toEqual([]);
    expect(findMeshOutliers(grid(values), 0.02)).toHaveLength(1);
  });

  it("dispersion générale : pas des mesures isolées, rien n'est signalé", () => {
    // Damier de ± 0,1 mm : tous les points s'écartent de leurs voisins.
    const checker = surface(8, 8, (r, c) => ((r + c) % 2 ? 0.1 : -0.1));
    expect(findMeshOutliers(checker, NOISE)).toEqual([]);
    // Plus de OUTLIER_MAX_COUNT pics, même sur une grande grille.
    const many = surface(30, 30, (r, c) => (r % 5 === 2 && c % 5 === 2 ? 0.5 : 0));
    expect((30 / 5) ** 2).toBeGreaterThan(OUTLIER_MAX_COUNT);
    expect(findMeshOutliers(many, NOISE)).toEqual([]);
  });

  it("grille de moins de 4 × 4 : non examinée", () => {
    expect(
      findMeshOutliers(
        grid([
          [0, 0, 0],
          [0, 1, 0],
          [0, 0, 0],
        ]),
        NOISE,
      ),
    ).toEqual([]);
  });

  it("plateau rond : les cases recopiées par Klipper ne sont ni jugées ni voisines", () => {
    // Grille réelle (corpus, OctoPrint-BedLevelVisualizer #225) : rangées complétées par Klipper.
    const round = grid([
      [-9.709671, -9.709671, -9.709671, -9.709671, -9.709671],
      [-8.882791, -8.882791, -10.053788, -11.430901, -11.430901],
      [-8.750643, -9.474328, -10.602038, -11.780672, -12.702485],
      [-10.316536, -10.316536, -11.288482, -12.20049, -12.20049],
      [-11.619917, -11.619917, -11.619917, -11.619917, -11.619917],
    ]);
    const padded = roundBedPadding(round);
    expect([...padded].sort((a, b) => a - b)).toEqual([
      0, 1, 2, 3, 4, 5, 9, 15, 19, 20, 21, 22, 23, 24,
    ]);
    expect(findMeshOutliers(round, NOISE)).toEqual([]);
    // Deux valeurs égales côte à côte au milieu d'une rangée : pas un remplissage.
    expect(roundBedPadding(grid([[0.1, -0.2, -0.2, 0.3]])).size).toBe(0);
  });

  it("dans le rapport : liste des points et diagnostic à refaire", () => {
    // Sortie réelle (corpus, OctoPrint-BedLevelVisualizer #92, 4ᵉ) : 0,05 au milieu de l'avant.
    const text = [
      "// Mesh Leveling Probed Z positions:",
      "// 0.000000 -0.080000 0.050000 -0.082500 -0.180000",
      "// -0.017500 -0.090000 -0.127500 -0.127500 -0.230000",
      "// -0.040000 -0.107500 -0.155000 -0.162500 -0.195000",
      "// -0.082500 -0.157500 -0.200000 -0.202500 -0.262500",
      "// -0.160000 -0.247500 -0.285000 -0.287500 -0.317500",
    ].join("\n");
    const result = analyzeBedMesh(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.meshes[0]?.outliers).toEqual([
      expect.objectContaining({ row: 0, col: 2, z: 0.05 }),
    ]);
    expect(result.value.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "bedMesh.outliers",
        severity: "warning",
        mesh: 0,
        params: { count: 1, deviation: expect.any(Number) },
      }),
    );
  });
});
