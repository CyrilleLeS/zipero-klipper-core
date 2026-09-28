// SPDX-License-Identifier: GPL-3.0-only
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { classifyMeshShape, type MeshShape } from "./shape";
import { type MeshGrid, toGrid } from "./types";

const grid = (values: number[][]): MeshGrid => {
  const result = toGrid(values);
  if (!result) throw new Error("grille invalide");
  return result;
};

/** Grille rows × cols échantillonnant z(u, v), u et v dans [-1, 1] (ligne 0 = avant). */
const sample = (rows: number, cols: number, z: (u: number, v: number) => number) =>
  grid(
    Array.from({ length: rows }, (_, row) =>
      Array.from({ length: cols }, (_, col) =>
        z(cols === 1 ? 0 : (2 * col) / (cols - 1) - 1, rows === 1 ? 0 : (2 * row) / (rows - 1) - 1),
      ),
    ),
  );

describe("classifyMeshShape — formes pures", () => {
  const cases: [string, (u: number, v: number) => number, MeshShape][] = [
    ["incliné", (u, v) => 0.2 * u + 0.1 * v, "tilted"],
    ["cuvette", (u, v) => 0.2 * (u * u + v * v), "bowl"],
    ["dôme", (u, v) => -0.2 * (u * u + v * v), "dome"],
    ["selle", (u, v) => 0.2 * (u * u - v * v), "saddle"],
    ["torsion", (u, v) => 0.2 * u * v, "twisted"],
  ];
  for (const [label, z, shape] of cases) {
    it(`reconnaît ${label} avec une confiance maximale`, () => {
      const result = classifyMeshShape(sample(7, 7, z));
      expect(result.shape).toBe(shape);
      expect(result.confidence).toBeCloseTo(1, 9);
      expect(result.explained).toBeCloseTo(1, 9);
      expect(result.secondary).toBeUndefined();
    });
  }

  it("mesure les amplitudes crête à crête des composantes", () => {
    const { components } = classifyMeshShape(
      sample(5, 5, (u, v) => 0.1 * u + 0.05 * v + 0.2 * u * u + 0.2 * v * v + 0.03 * u * v),
    );
    expect(components.tilt).toBeCloseTo(0.3, 9);
    expect(components.curvature).toBeCloseTo(0.4, 9);
    expect(components.twist).toBeCloseTo(0.06, 9);
    expect(components.residual).toBeCloseTo(0, 9);
  });

  it("indique l'axe d'une courbure en gouttière", () => {
    expect(classifyMeshShape(sample(5, 5, (u) => 0.3 * u * u)).curvatureAxis).toBe("x");
    expect(classifyMeshShape(sample(5, 5, (_, v) => -0.3 * v * v))).toMatchObject({
      shape: "dome",
      curvatureAxis: "y",
    });
    expect(classifyMeshShape(sample(5, 5, (u, v) => 0.3 * (u * u + v * v))).curvatureAxis).toBe(
      "both",
    );
  });

  it("indique la diagonale haute d'une torsion", () => {
    // u·v > 0 à l'avant gauche (u, v < 0) et à l'arrière droit (u, v > 0).
    expect(classifyMeshShape(sample(5, 5, (u, v) => 0.2 * u * v)).highDiagonal).toBe(
      "frontLeft-backRight",
    );
    expect(classifyMeshShape(sample(5, 5, (u, v) => -0.2 * u * v)).highDiagonal).toBe(
      "frontRight-backLeft",
    );
  });
});

describe("classifyMeshShape — cas limites", () => {
  it("déclare plat sous la tolérance, avec une confiance qui baisse près du seuil", () => {
    const nearlyFlat = classifyMeshShape(sample(5, 5, (u) => 0.045 * u));
    expect(nearlyFlat.shape).toBe("flat");
    expect(nearlyFlat.confidence).toBeCloseTo(0.1, 9);
    expect(classifyMeshShape(sample(5, 5, () => 0.3))).toMatchObject({
      shape: "flat",
      confidence: 1,
    });
    // Tolérance réglable.
    expect(
      classifyMeshShape(
        sample(5, 5, (u) => 0.045 * u),
        { flatTolerance: 0.05 },
      ).shape,
    ).toBe("tilted");
  });

  it("déclare irrégulière une bosse locale que la surface quadratique n'explique pas", () => {
    const values = sample(7, 7, () => 0).values.map((row) => [...row]);
    const line = values[1];
    if (!line) throw new Error("ligne absente");
    line[5] = 0.4;
    const result = classifyMeshShape(grid(values));
    expect(result.shape).toBe("irregular");
    expect(result.confidence).toBeGreaterThan(0.5);
    expect(result.components.residual).toBeGreaterThan(0.3);
  });

  it("signale une seconde forme notable et baisse la confiance", () => {
    const result = classifyMeshShape(sample(7, 7, (u, v) => 0.2 * (u * u + v * v) + 0.12 * u));
    expect(result.shape).toBe("bowl");
    expect(result.secondary).toBe("tilted");
    expect(result.confidence).toBeCloseTo(1 - 0.24 / 0.4, 9);
  });

  it("n'identifie que les termes permis par la taille de la grille", () => {
    // Deux points par axe : pas de courbure mesurable, l'inclinaison reste lisible.
    expect(classifyMeshShape(sample(2, 2, (u, v) => 0.2 * u + 0.1 * v)).shape).toBe("tilted");
    // Une seule rangée : courbure le long de X uniquement.
    expect(classifyMeshShape(sample(1, 5, (u) => 0.3 * u * u))).toMatchObject({
      shape: "bowl",
      curvatureAxis: "x",
    });
    expect(classifyMeshShape(sample(1, 1, () => 0.5)).shape).toBe("flat");
  });

  it("gère une grille rectangulaire sans dépendre de l'échelle des axes", () => {
    expect(classifyMeshShape(sample(3, 9, (u, v) => 0.2 * u * v)).shape).toBe("twisted");
  });

  it("ne confond pas deux composantes égales : confiance nulle", () => {
    const result = classifyMeshShape(sample(5, 5, (u, v) => 0.1 * u + 0.1 * u * v));
    expect(result.confidence).toBeCloseTo(0, 9);
  });
});

describe("classifyMeshShape — propriétés", () => {
  const coefficient = fc.double({ min: -0.5, max: 0.5, noNaN: true });
  const surface = fc.record({
    b: coefficient,
    c: coefficient,
    d: coefficient,
    e: coefficient,
    f: coefficient,
  });
  const evaluate =
    ({ b, c, d, e, f }: { b: number; c: number; d: number; e: number; f: number }, sign = 1) =>
    (u: number, v: number) =>
      sign * (b * u + c * v + d * u * u + e * u * v + f * v * v);

  it("ajouter une constante (décalage Z) ne change rien", () => {
    fc.assert(
      fc.property(surface, fc.double({ min: -2, max: 2, noNaN: true }), (s, offset) => {
        const a = classifyMeshShape(sample(5, 5, evaluate(s)));
        const z = evaluate(s);
        const b = classifyMeshShape(sample(5, 5, (u, v) => z(u, v) + offset));
        expect(b.shape).toBe(a.shape);
        expect(b.confidence).toBeCloseTo(a.confidence, 6);
      }),
    );
  });

  it("retourner le plateau (z → −z) échange cuvette et dôme, garde les autres formes", () => {
    const swap: Record<MeshShape, MeshShape> = {
      flat: "flat",
      tilted: "tilted",
      bowl: "dome",
      dome: "bowl",
      saddle: "saddle",
      twisted: "twisted",
      irregular: "irregular",
    };
    fc.assert(
      fc.property(surface, (s) => {
        const up = classifyMeshShape(sample(5, 5, evaluate(s)));
        const down = classifyMeshShape(sample(5, 5, evaluate(s, -1)));
        // Égalité exacte de composantes : l'ordre de tri peut départager autrement.
        fc.pre(up.confidence > 1e-6);
        expect(down.shape).toBe(swap[up.shape]);
      }),
    );
  });

  it("la confiance reste entre 0 et 1", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.array(fc.double({ min: -1, max: 1, noNaN: true }), { minLength: 4, maxLength: 4 }),
          {
            minLength: 4,
            maxLength: 4,
          },
        ),
        (values) => {
          const { confidence, explained } = classifyMeshShape(grid(values));
          expect(confidence).toBeGreaterThanOrEqual(0);
          expect(confidence).toBeLessThanOrEqual(1);
          expect(explained).toBeGreaterThanOrEqual(0);
          expect(explained).toBeLessThanOrEqual(1);
        },
      ),
    );
  });
});
