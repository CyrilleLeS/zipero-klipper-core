// SPDX-License-Identifier: GPL-3.0-only
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DEFAULT_INTERPOLATION, effectiveAlgorithm, interpolateMesh } from "./interpolate";
import { type MeshGrid, toGrid } from "./types";

const grid = (values: number[][]): MeshGrid => {
  const result = toGrid(values);
  if (!result) throw new Error("grille invalide");
  return result;
};
const plane = (rows: number, cols: number) =>
  grid(
    Array.from({ length: rows }, (_, r) =>
      Array.from({ length: cols }, (_, c) => 0.1 * c - 0.05 * r),
    ),
  );

describe("effectiveAlgorithm (comme _verify_algorithm de Klipper)", () => {
  const params = (algorithm: string, pps = 2) => ({
    ...DEFAULT_INTERPOLATION,
    algorithm,
    xPps: pps,
    yPps: pps,
  });
  it("désactive l'interpolation quand pps = 0", () => {
    expect(effectiveAlgorithm(5, 5, params("bicubic", 0))).toBe("direct");
  });
  it("refuse Lagrange au-delà de 6 points, ramène le bicubique à Lagrange sous 4", () => {
    expect(effectiveAlgorithm(7, 5, params("lagrange"))).toBe("interpolate.lagrange-too-many");
    expect(effectiveAlgorithm(3, 5, params("bicubic"))).toBe("lagrange");
    expect(effectiveAlgorithm(3, 7, params("bicubic"))).toBe("interpolate.bicubic-invalid");
    expect(effectiveAlgorithm(9, 9, params(" Bicubic "))).toBe("bicubic");
    expect(effectiveAlgorithm(5, 5, params("spline"))).toBe("interpolate.unknown-algorithm");
  });
});

describe("interpolateMesh", () => {
  it("donne la taille de grille de Klipper et passe par les points mesurés", () => {
    const probed = grid([
      [0, 0.1, 0.05],
      [0.02, 0.2, -0.1],
      [0.03, -0.05, 0],
    ]);
    const result = interpolateMesh(probed, DEFAULT_INTERPOLATION);
    if (!result.ok) throw new Error(result.code);
    expect(result.algorithm).toBe("lagrange");
    expect([result.grid.cols, result.grid.rows]).toEqual([7, 7]);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        expect(result.grid.values[r * 3]?.[c * 3]).toBe(probed.values[r]?.[c]);
      }
    }
  });

  it("recopie la grille en mode direct et signale un réglage refusé", () => {
    const direct = interpolateMesh(plane(3, 3), { ...DEFAULT_INTERPOLATION, xPps: 0, yPps: 0 });
    expect(direct.ok && direct.grid).toEqual(plane(3, 3));
    expect(interpolateMesh(plane(7, 7), DEFAULT_INTERPOLATION)).toEqual({
      ok: false,
      code: "interpolate.lagrange-too-many",
    });
  });

  it("conserve exactement un plan (Lagrange et bicubique), quels que soient les pps", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 4, max: 6 }),
        fc.integer({ min: 4, max: 6 }),
        fc.integer({ min: 1, max: 4 }),
        fc.constantFrom("lagrange", "bicubic"),
        (rows, cols, pps, algorithm) => {
          // Spline cardinale : un plan est conservé avec la tension 0,5 (Catmull-Rom).
          const result = interpolateMesh(plane(rows, cols), {
            xPps: pps,
            yPps: pps,
            algorithm,
            tension: algorithm === "bicubic" ? 0.5 : 0.2,
          });
          if (!result.ok) throw new Error(result.code);
          const xStep = (cols - 1) / (result.grid.cols - 1);
          const yStep = (rows - 1) / (result.grid.rows - 1);
          for (const [r, line] of result.grid.values.entries()) {
            for (const [c, value] of line.entries()) {
              const inner = c > 0 && c < result.grid.cols - 1 && r > 0 && r < result.grid.rows - 1;
              // Aux bords, la spline de Klipper duplique le point extrême (p0 = p1) : pas un plan.
              if (algorithm === "lagrange" || inner) {
                const edge =
                  algorithm === "bicubic" &&
                  (c < pps + 1 ||
                    c > result.grid.cols - pps - 2 ||
                    r < pps + 1 ||
                    r > result.grid.rows - pps - 2);
                if (!edge) expect(value).toBeCloseTo(0.1 * c * xStep - 0.05 * r * yStep, 9);
              }
            }
          }
        },
      ),
    );
  });
});
