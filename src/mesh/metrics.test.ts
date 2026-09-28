// SPDX-License-Identifier: GPL-3.0-only
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { computeMeshMetrics } from "./metrics";
import { type MeshGrid, toGrid } from "./types";

const grid = (values: number[][]): MeshGrid => {
  const result = toGrid(values);
  if (!result) throw new Error("grille invalide");
  return result;
};

describe("computeMeshMetrics — valeurs connues", () => {
  // Plateau incliné vers l'arrière de 0,05 mm par rangée, avec une bosse au centre.
  const values = [
    [-0.05, -0.05, -0.05],
    [0.0, 0.03, 0.0],
    [0.05, 0.05, 0.05],
  ];
  const geometry = { minX: 30, maxX: 230, minY: 30, maxY: 230 }; // pas de 100 mm
  const metrics = computeMeshMetrics(grid(values), geometry);

  it("calcule min, max (avec position), amplitude, moyenne et écart-type de population", () => {
    expect(metrics.count).toBe(9);
    expect(metrics.min).toEqual({ row: 0, col: 0, z: -0.05 });
    expect(metrics.max).toEqual({ row: 2, col: 0, z: 0.05 });
    expect(metrics.range).toBeCloseTo(0.1, 12);
    expect(metrics.mean).toBeCloseTo(0.03 / 9, 12);
    const mean = 0.03 / 9;
    const expectedStd = Math.sqrt(values.flat().reduce((s, z) => s + (z - mean) ** 2, 0) / 9);
    expect(metrics.stdDev).toBeCloseTo(expectedStd, 12);
  });

  it("mesure l'inclinaison en mm / 100 mm et le dénivelé sur toute la profondeur", () => {
    expect(metrics.plane.slopeXPer100mm).toBeCloseTo(0, 12);
    expect(metrics.plane.slopeYPer100mm).toBeCloseTo(0.05, 12);
    expect(metrics.plane.riseY).toBeCloseTo(0.1, 12);
  });

  it("isole la bosse centrale dans les résidus après retrait du plan", () => {
    // Plan retiré : il reste la bosse de 0,03 (moins sa part de moyenne).
    expect(metrics.plane.residualRange).toBeCloseTo(0.03, 12);
  });

  it("donne des pentes nulles (inconnues) sans emprise, mais les résidus restent calculés", () => {
    const withoutGeometry = computeMeshMetrics(grid(values));
    expect(withoutGeometry.plane.slopeYPer100mm).toBeNull();
    expect(withoutGeometry.plane.slopeXPer100mm).toBeNull();
    expect(withoutGeometry.plane.residualRange).toBeCloseTo(0.03, 12);
  });

  it("supporte un maillage très dense (400×400) sans débordement de pile", () => {
    const size = 400;
    const values = Array.from({ length: size }, (_, r) =>
      Array.from({ length: size }, (_, c) => (r + c) / 1000),
    );
    const metrics = computeMeshMetrics(grid(values), { minX: 0, maxX: 399, minY: 0, maxY: 399 });
    expect(metrics.count).toBe(160_000);
    expect(metrics.plane.residualRange).toBeLessThan(1e-9);
  });

  it("gère un axe à un seul point", () => {
    const line = computeMeshMetrics(grid([[0.1, 0.2, 0.3]]), {
      minX: 0,
      maxX: 200,
      minY: 0,
      maxY: 0,
    });
    expect(line.plane.slopeXPer100mm).toBeCloseTo(0.1, 12);
    expect(line.plane.slopeYPer100mm).toBeNull();
    expect(line.plane.riseY).toBe(0);
  });
});

// Grilles aléatoires réalistes : 3 à 9 points par axe, écarts de ±1 mm.
const arbitraryGrid = fc
  .tuple(fc.integer({ min: 3, max: 9 }), fc.integer({ min: 3, max: 9 }))
  .chain(([rows, cols]) =>
    fc.array(
      fc.array(fc.double({ min: -1, max: 1, noNaN: true }), { minLength: cols, maxLength: cols }),
      {
        minLength: rows,
        maxLength: rows,
      },
    ),
  )
  .map(grid);

describe("computeMeshMetrics — propriétés", () => {
  const geometry = { minX: 0, maxX: 220, minY: 0, maxY: 220 };

  it("retrouve exactement un plan parfait (résidus nuls)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 3, max: 9 }),
        fc.integer({ min: 3, max: 9 }),
        fc.double({ min: -0.5, max: 0.5, noNaN: true }),
        fc.double({ min: -0.5, max: 0.5, noNaN: true }),
        fc.double({ min: -1, max: 1, noNaN: true }),
        (rows, cols, sx, sy, offset) => {
          const stepX = 220 / (cols - 1);
          const stepY = 220 / (rows - 1);
          const values = Array.from({ length: rows }, (_, r) =>
            Array.from(
              { length: cols },
              (_, c) => offset + (sx * c * stepX) / 100 + (sy * r * stepY) / 100,
            ),
          );
          const { plane } = computeMeshMetrics(grid(values), geometry);
          expect(plane.slopeXPer100mm).toBeCloseTo(sx, 9);
          expect(plane.slopeYPer100mm).toBeCloseTo(sy, 9);
          expect(plane.residualRange).toBeLessThan(1e-9);
        },
      ),
    );
  });

  it("est invariant par translation verticale (seules min, max et moyenne se décalent)", () => {
    fc.assert(
      fc.property(arbitraryGrid, fc.double({ min: -2, max: 2, noNaN: true }), (g, shift) => {
        const a = computeMeshMetrics(g, geometry);
        const b = computeMeshMetrics(
          grid(g.values.map((row) => row.map((z) => z + shift))),
          geometry,
        );
        expect(b.range).toBeCloseTo(a.range, 9);
        expect(b.stdDev).toBeCloseTo(a.stdDev, 9);
        expect(b.mean).toBeCloseTo(a.mean + shift, 9);
        expect(b.plane.residualRange).toBeCloseTo(a.plane.residualRange, 9);
        expect(b.plane.slopeXPer100mm ?? 0).toBeCloseTo(a.plane.slopeXPer100mm ?? 0, 9);
      }),
    );
  });

  it("respecte les bornes : résidus ≤ amplitude, écart-type ≤ amplitude, min ≤ moyenne ≤ max", () => {
    fc.assert(
      fc.property(arbitraryGrid, (g) => {
        const m = computeMeshMetrics(g, geometry);
        expect(m.stdDev).toBeLessThanOrEqual(m.range + 1e-12);
        expect(m.min.z).toBeLessThanOrEqual(m.mean + 1e-12);
        expect(m.mean).toBeLessThanOrEqual(m.max.z + 1e-12);
        expect(m.plane.residualStdDev).toBeLessThanOrEqual(m.stdDev + 1e-12);
      }),
    );
  });

  it("change le signe de la pente X quand on retourne le plateau gauche/droite", () => {
    fc.assert(
      fc.property(arbitraryGrid, (g) => {
        const mirrored = grid(g.values.map((row) => [...row].reverse()));
        const a = computeMeshMetrics(g, geometry).plane.slopeXPer100mm ?? 0;
        const b = computeMeshMetrics(mirrored, geometry).plane.slopeXPer100mm ?? 0;
        expect(b).toBeCloseTo(-a, 9);
      }),
    );
  });
});
