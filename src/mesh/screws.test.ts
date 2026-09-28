// SPDX-License-Identifier: GPL-3.0-only
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  isScrewThread,
  parseScrewsTiltOutput,
  pythonRound,
  sampleMesh,
  screwReadingsFromMesh,
  screwsTiltAdjust,
} from "./screws";
import { toGrid } from "./types";

const reading = (name: string, z: number) => ({ name, x: 0, y: 0, z });

describe("pythonRound (round de Python 3)", () => {
  it("arrondit les moitiés au pair le plus proche (valeurs positives : minutes de cadran)", () => {
    expect([0.5, 1.5, 2.5, 14.5, 15.5, 0.4999, 0.5001, 59.5].map(pythonRound)).toEqual([
      0, 2, 2, 14, 16, 0, 1, 60,
    ]);
  });
});

describe("screwsTiltAdjust", () => {
  it("prend la première vis comme base et convertit l'écart en tours du filetage", () => {
    // M3 : 0,5 mm par tour. Vis 2 plus basse de 0,1275 mm → 0,255 tour → 15,3 min → 00:15 CW.
    const [base, lower, higher] = screwsTiltAdjust(
      [
        reading("avant gauche", 2.4875),
        reading("avant droite", 2.36),
        reading("arrière droite", 2.715),
      ],
      "CW-M3",
    );
    expect(base).toMatchObject({ base: true, label: "00:00", direction: "CW" });
    expect(lower).toMatchObject({
      base: false,
      direction: "CW",
      turns: 0,
      minutes: 15,
      label: "00:15",
    });
    // 0,2275 / 0,5 = 0,455 tour → 27,3 min, dans l'autre sens.
    expect(higher).toMatchObject({ direction: "CCW", label: "00:27" });
  });

  it("inverse le sens pour un filetage à gauche et adapte le pas", () => {
    const [, screw] = screwsTiltAdjust([reading("a", 1), reading("b", 0.3)], "CCW-M4");
    // 0,7 / 0,7 = 1 tour exactement, sens antihoraire pour un filetage CCW.
    expect(screw).toMatchObject({ direction: "CCW", turns: 1, minutes: 0, label: "01:00" });
  });

  it("ignore un écart sous 0,001 mm", () => {
    const [, screw] = screwsTiltAdjust([reading("a", 1), reading("b", 1.0009)]);
    expect(screw).toMatchObject({ turns: 0, minutes: 0, direction: "CW" });
  });

  it("DIRECTION choisit la base pour ne tourner que dans un sens", () => {
    const readings = [reading("a", 1), reading("b", 1.2), reading("c", 0.9)];
    const cw = screwsTiltAdjust(readings, "CW-M3", "CW");
    expect(cw.find((s) => s.base)?.name).toBe("b");
    expect(cw.filter((s) => !s.base).every((s) => s.direction === "CW")).toBe(true);
    const ccw = screwsTiltAdjust(readings, "CW-M3", "CCW");
    expect(ccw.find((s) => s.base)?.name).toBe("c");
    expect(ccw.filter((s) => !s.base).every((s) => s.direction === "CCW")).toBe(true);
    expect(screwsTiltAdjust([], "CW-M3")).toEqual([]);
  });

  it("appliquer le réglage calculé ramène chaque vis au niveau de la base", () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: -1, max: 1, noNaN: true }), { minLength: 3, maxLength: 9 }),
        fc.constantFrom("CW-M3", "CCW-M3", "CW-M4", "CW-M5", "CCW-M6" as const),
        (zs, thread) => {
          const pitch = { M3: 0.5, M4: 0.7, M5: 0.8, M6: 1 }[thread.split("-")[1] as "M3"];
          const result = screwsTiltAdjust(
            zs.map((z, i) => reading(`v${i}`, z)),
            thread,
          );
          const base = result[0]?.z ?? 0;
          for (const screw of result.slice(1)) {
            const turns = screw.turns + screw.minutes / 60;
            // CW (filetage CW) rapproche le plateau : z mesuré augmente.
            const raises = (screw.direction === "CW") === thread.startsWith("CW");
            const after = screw.z + (raises ? 1 : -1) * turns * pitch;
            // Erreur ≤ ½ minute d'arrondi, ou écart ignoré sous 0,001 mm.
            expect(Math.abs(after - base)).toBeLessThanOrEqual(Math.max(pitch / 120, 0.001) + 1e-9);
          }
        },
      ),
    );
  });

  it("reconnaît les filetages de Klipper", () => {
    expect(isScrewThread("CCW-M5")).toBe(true);
    expect(isScrewThread("CW-M8")).toBe(false);
  });
});

describe("hauteur des vis lue sur le maillage", () => {
  // Plan z = 0,001·x + 0,002·y sur 0..100 × 0..100, grille 3 × 3.
  const surface = toGrid([
    [0, 0.05, 0.1],
    [0.1, 0.15, 0.2],
    [0.2, 0.25, 0.3],
  ]);
  const geometry = { minX: 0, maxX: 100, minY: 0, maxY: 100 };

  it("échantillonne comme calc_z (bilinéaire) et borne hors du maillage", () => {
    if (!surface) throw new Error("grille");
    expect(sampleMesh(surface, geometry, 25, 75).z).toBeCloseTo(0.025 + 0.15, 12);
    expect(sampleMesh(surface, geometry, 100, 100)).toEqual({ z: 0.3, clamped: false });
    expect(sampleMesh(surface, geometry, 130, -10)).toMatchObject({ z: 0.1, clamped: true });
  });

  it("mesure là où la sonde passe au-dessus de la vis (buse + décalage)", () => {
    if (!surface) throw new Error("grille");
    const [screw, outside] = screwReadingsFromMesh(
      surface,
      geometry,
      [
        { x: 40, y: 20, name: "avant gauche" },
        { x: 150, y: 50 },
      ],
      { x: 10, y: -10 },
    );
    expect(screw).toMatchObject({ name: "avant gauche", x: 40, y: 20, outsideMesh: false });
    expect(screw?.z).toBeCloseTo(0.001 * 50 + 0.002 * 10, 12);
    expect(outside).toMatchObject({ name: "screw at 150.000,50.000", outsideMesh: true });
  });
});

describe("parseScrewsTiltOutput", () => {
  it("lit une sortie console, préfixes et horodatages compris, et sépare les passages", () => {
    const runs = parseScrewsTiltOutput(
      [
        "Recv: // 01:20 means 1 full turn and 20 minutes, CW=clockwise, CCW=counter-clockwise",
        "Recv: // front left screw (base) : x=-5.0, y=30.0, z=2.48750",
        "// front right screw : x=155.0, y=30.0, z=2.36000 : adjust CW 00:15 16:09:22",
        "front left screw (base) : x=-5.0, y=30.0, z=2.40000",
        "front right screw : x=155.0, y=30.0, z=2.40100 : adjust CCW 00:00",
      ].join("\n"),
    );
    expect(runs).toHaveLength(2);
    expect(runs[0]?.[0]).toEqual({ name: "front left screw", x: -5, y: 30, z: 2.4875, base: true });
    expect(runs[0]?.[1]?.printed).toEqual({ direction: "CW", turns: 0, minutes: 15 });
    expect(parseScrewsTiltOutput("rien")).toEqual([]);
  });
});
