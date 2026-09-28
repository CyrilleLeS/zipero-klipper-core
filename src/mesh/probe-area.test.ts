// SPDX-License-Identifier: GPL-3.0-only
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { PrinterMechanics } from "../printers/extract";
import { checkProbeArea, type ProbeArea } from "./probe-area";

const travel = { minX: 0, maxX: 235, minY: 0, maxY: 235 };
const bltouch = { type: "bltouch", xOffset: -44, yOffset: -6 };

const area = (mechanics: PrinterMechanics): ProbeArea => {
  const result = checkProbeArea(mechanics);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
};

describe("checkProbeArea — plateau rectangulaire", () => {
  it("génère les points comme Klipper (pas au centième inférieur, serpentin)", () => {
    const { points, probed } = area({
      travel,
      probe: { type: "probe", xOffset: 0, yOffset: 0 },
      mesh: { min: [10, 10], max: [110, 50], probeCount: [4, 3] },
    });
    // (110 − 10) / 3 = 33,333… → 33,33 : max_x recalculé = 109,99.
    expect(points.map((p) => [Math.round(p.x * 100) / 100, p.y])).toEqual([
      [10, 10],
      [43.33, 10],
      [76.66, 10],
      [109.99, 10],
      [109.99, 30],
      [76.66, 30],
      [43.33, 30],
      [10, 30],
      [10, 50],
      [43.33, 50],
      [76.66, 50],
      [109.99, 50],
    ]);
    expect(probed.maxX).toBeCloseTo(109.99, 9);
  });

  it("valide une zone atteignable (Ender 3, BLTouch à gauche)", () => {
    const result = area({
      travel,
      probe: bltouch,
      mesh: { min: [30, 30], max: [185, 225], probeCount: [5, 5] },
    });
    expect(result.problems).toEqual([]);
    // La buse peut aller de 0 à 235 : la sonde, décalée de −44 / −6, couvre −44…191 et −6…229.
    expect(result.reachable).toEqual({ minX: -44, maxX: 191, minY: -6, maxY: 229 });
  });

  it("signale un mesh_max inatteignable et propose la valeur corrigée", () => {
    const result = area({
      travel,
      probe: bltouch,
      mesh: { min: [30, 30], max: [200, 200], probeCount: [5, 5] },
    });
    expect(result.problems).toEqual([
      {
        code: "probeArea.outOfRange",
        params: { axis: "x", side: "max", excess: 9, suggested: 191 },
      },
    ]);
  });

  it("signale un mesh_min trop bas avec une sonde décalée vers l'avant droit", () => {
    const result = area({
      travel: { minX: -5, maxX: 300, minY: 0, maxY: 300 },
      probe: { type: "beacon", xOffset: 0, yOffset: 18.7 },
      mesh: { min: [5, 10], max: [295, 290], probeCount: [40, 40] },
    });
    expect(result.problems).toEqual([
      {
        code: "probeArea.outOfRange",
        params: { axis: "y", side: "min", excess: 8.7, suggested: 18.7 },
      },
    ]);
  });

  it("utilise probe_count 3 × 3 par défaut", () => {
    expect(
      area({ travel, probe: bltouch, mesh: { min: [30, 30], max: [150, 150] } }).points,
    ).toHaveLength(9);
  });

  it("refuse les réglages que Klipper refuse", () => {
    const code = (mesh: PrinterMechanics["mesh"]) => {
      const result = checkProbeArea({ travel, probe: bltouch, ...(mesh ? { mesh } : {}) });
      return result.ok ? "ok" : result.error.code;
    };
    expect(code({ min: [100, 30], max: [50, 150] })).toBe("probeArea.invalidMinMax");
    expect(code({ min: [30, 30], max: [32, 150], probeCount: [5, 5] })).toBe("probeArea.tooClose");
    expect(code({ min: [30, 30], max: [150, 150], probeCount: [2, 5] })).toBe(
      "probeArea.countTooLow",
    );
    expect(code({ probeCount: [5, 5] })).toBe("probeArea.noMesh");
    expect(code(undefined)).toBe("probeArea.noMesh");
  });

  it("exige la course des axes et une sonde", () => {
    const mesh = { min: [30, 30], max: [150, 150] } as const;
    const noTravel = checkProbeArea({ probe: bltouch, mesh });
    const noProbe = checkProbeArea({ travel, mesh });
    expect(noTravel.ok ? null : noTravel.error.code).toBe("probeArea.noTravel");
    expect(noProbe.ok ? null : noProbe.error.code).toBe("probeArea.noProbe");
  });
});

describe("checkProbeArea — plateau rond", () => {
  const square = { minX: 0, maxX: 200, minY: 0, maxY: 200 };
  const probe = { type: "probe", xOffset: 0, yOffset: 0 };

  it("garde les points à moins du rayon et les décale de mesh_origin", () => {
    const { shape, points } = area({
      travel: square,
      probe,
      mesh: { radius: 90, origin: [100, 100], roundProbeCount: 5 },
    });
    expect(shape).toBe("round");
    // Grille 5 × 5 au pas de 45, rayon 90 : les points à (45, 90) sont à 100,6 mm, exclus.
    // Restent 5 (rangée centrale) + 3 + 3 (rangées ±45) + 1 + 1 (rangées ±90).
    expect(points).toHaveLength(13);
    expect(points).toContainEqual({ x: 10, y: 100 });
    expect(points).not.toContainEqual({ x: 10, y: 10 });
  });

  it("propose le plus grand rayon qui tient dans la course", () => {
    const result = area({
      travel: square,
      probe,
      mesh: { radius: 110, origin: [100, 100], roundProbeCount: 5 },
    });
    expect(result.problems).toHaveLength(4);
    expect(result.problems[0]).toEqual({
      code: "probeArea.outOfRange",
      params: { axis: "x", side: "min", excess: 10, suggested: 100 },
    });
  });

  it("refuse un nombre de points pair ou trop faible, et un pas sous 1 mm", () => {
    const code = (radius: number, roundProbeCount: number) => {
      const result = checkProbeArea({ travel: square, probe, mesh: { radius, roundProbeCount } });
      return result.ok ? "ok" : result.error.code;
    };
    expect(code(90, 6)).toBe("probeArea.roundCountEven");
    expect(code(90, 1)).toBe("probeArea.countTooLow");
    expect(code(1, 5)).toBe("probeArea.tooClose");
  });
});

describe("checkProbeArea — propriétés", () => {
  it("après correction suggérée, la zone rectangulaire est atteignable", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -60, max: 60 }),
        fc.integer({ min: -60, max: 60 }),
        fc.integer({ min: 3, max: 15 }),
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 130, max: 300 }),
        (xOffset, yOffset, count, low, high) => {
          const probe = { type: "probe", xOffset, yOffset };
          const mesh = { min: [low, low], max: [high, high], probeCount: [count, count] } as const;
          const first = area({ travel, probe, mesh });
          const fixed = { min: [...mesh.min], max: [...mesh.max] };
          for (const { params } of first.problems) {
            const { axis, side, suggested } = params ?? {};
            const target = side === "min" ? fixed.min : fixed.max;
            target[axis === "x" ? 0 : 1] = Number(suggested);
          }
          const [minX, minY] = fixed.min;
          const [maxX, maxY] = fixed.max;
          fc.pre(
            minX !== undefined && minY !== undefined && maxX !== undefined && maxY !== undefined,
          );
          fc.pre((maxX ?? 0) - (minX ?? 0) >= 2 * count && (maxY ?? 0) - (minY ?? 0) >= 2 * count);
          const second = checkProbeArea({
            travel,
            probe,
            mesh: {
              min: [minX ?? 0, minY ?? 0],
              max: [maxX ?? 0, maxY ?? 0],
              probeCount: [count, count],
            },
          });
          expect(second.ok && second.value.problems).toEqual([]);
        },
      ),
    );
  });
});
