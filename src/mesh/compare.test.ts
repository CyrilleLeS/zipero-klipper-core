// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from "vitest";
import { compareMeshes } from "./compare";
import type { MeshGrid } from "./types";

const grid = (values: number[][]): MeshGrid => ({
  rows: values.length,
  cols: values[0]?.length ?? 0,
  values,
});
const GEOMETRY = { minX: 10, maxX: 210, minY: 20, maxY: 220 };
const BEFORE = grid([
  [0.1, 0.0, -0.1],
  [0.1, 0.0, -0.1],
  [0.1, 0.0, -0.1],
]);

describe("comparaison de deux maillages (EP-05.12)", () => {
  it("décalage commun séparé de ce qui a changé de forme", () => {
    // Après : tout le plateau 0,05 plus haut, et le coin arrière droit relevé de 0,09 en plus.
    const after = grid([
      [0.15, 0.05, -0.05],
      [0.15, 0.05, -0.05],
      [0.15, 0.05, 0.04],
    ]);
    const result = compareMeshes(
      { grid: BEFORE, geometry: GEOMETRY },
      { grid: after, geometry: GEOMETRY },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { raw, centered, offset, largest, rangeA, rangeB } = result.value;
    expect(raw.values[0]?.[0]).toBeCloseTo(0.05, 9);
    expect(raw.values[2]?.[2]).toBeCloseTo(0.14, 9);
    expect(offset).toBeCloseTo(0.06, 9);
    expect(centered.values[0]?.[0]).toBeCloseTo(-0.01, 9);
    expect(largest).toMatchObject({ row: 2, col: 2 });
    expect(largest.value).toBeCloseTo(0.08, 9);
    expect(rangeA).toBeCloseTo(0.2, 9);
    expect(rangeB).toBeCloseTo(0.2, 9);
    expect(result.warnings).toEqual([]);
  });

  it("deux maillages identiques : aucune différence", () => {
    const result = compareMeshes({ grid: BEFORE }, { grid: BEFORE });
    expect(result.ok && result.value.offset).toBe(0);
    expect(result.ok && result.value.largest.value).toBe(0);
  });

  it("tailles différentes : refus, avec les deux tailles", () => {
    const small = grid([
      [0, 0],
      [0, 0],
    ]);
    expect(compareMeshes({ grid: BEFORE }, { grid: small })).toMatchObject({
      ok: false,
      error: { code: "compare.size-mismatch", params: { rowsA: 3, colsA: 3, rowsB: 2, colsB: 2 } },
    });
  });

  it("emprises différentes : refus ; écart d'arrondi toléré ; une seule connue : remarque", () => {
    const shifted = { ...GEOMETRY, maxX: 200 };
    expect(
      compareMeshes({ grid: BEFORE, geometry: GEOMETRY }, { grid: BEFORE, geometry: shifted }),
    ).toMatchObject({ ok: false, error: { code: "compare.geometry-mismatch" } });
    const rounded = { ...GEOMETRY, maxX: 210.004 };
    expect(
      compareMeshes({ grid: BEFORE, geometry: GEOMETRY }, { grid: BEFORE, geometry: rounded }).ok,
    ).toBe(true);
    const oneSided = compareMeshes({ grid: BEFORE, geometry: GEOMETRY }, { grid: BEFORE });
    expect(oneSided.ok && oneSided.warnings).toEqual([{ code: "compare.geometry-unknown" }]);
  });
});
