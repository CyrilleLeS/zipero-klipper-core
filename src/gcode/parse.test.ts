// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from "vitest";
import { parseGcode } from "./parse";
import { GCODE_ROLES, roleIndex } from "./roles";

// Le paquet autonome n'a ni types Node ni DOM (pas de TextEncoder) ; le G-code est en ASCII.
const ascii = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));
const gcode = (...lines: string[]) => ascii(`${lines.join("\n")}\n`);
const role = (name: (typeof GCODE_ROLES)[number]) => GCODE_ROLES.indexOf(name);
/** Sommets [x, y, z] du segment n. */
const segment = (positions: Float32Array, n: number) =>
  Array.from(positions.subarray(n * 6, n * 6 + 6), (v) => Math.round(v * 1000) / 1000);

describe("parseGcode : trajectoire", () => {
  it("extrusions en E relatif, déplacements, couches, vitesse en mm/s", () => {
    const result = parseGcode(
      gcode(
        "M83",
        "G90",
        "G0 X10 Y10 Z0.2 F9000",
        "G1 X20 Y10 E0.5 F1800",
        "G1 X20 Y20 E0.5",
        "G0 X30 Y30",
        "G0 Z0.4",
        "G1 X40 Y30 E0.5",
      ),
    );
    expect(result.segments).toBe(3);
    expect(segment(result.positions, 0)).toEqual([10, 10, 0.2, 20, 10, 0.2]);
    expect(segment(result.positions, 2)).toEqual([30, 30, 0.4, 40, 30, 0.4]);
    expect(Array.from(result.layerStarts)).toEqual([0, 2]);
    expect(Array.from(result.layerZ, (z) => Math.round(z * 1000) / 1000)).toEqual([0.2, 0.4]);
    expect(result.feedrates[0]).toBe(30);
    expect(result.stats).toMatchObject({ travels: 2, filamentMm: 1.5, retractions: 0 });
    expect(result.bounds).toEqual([10, 10, expect.closeTo(0.2), 40, 30, expect.closeTo(0.4)]);
  });

  it("E absolu (M82), G92 E0, rétractions par E et par G10", () => {
    const result = parseGcode(
      gcode(
        "M82",
        "G92 E0",
        "G1 Z0.2",
        "G1 X10 Y0 E1",
        "G1 E0.2",
        "G1 E1",
        "G1 X20 E2",
        "G92 E0",
        "G1 X30 E1",
        "G10",
      ),
    );
    expect(result.segments).toBe(3);
    expect(Array.from(result.extrusions)).toEqual([1, 1, 1]);
    expect(result.stats.retractions).toBe(2);
  });

  it("coordonnées relatives (G91) et pouces (G20)", () => {
    const relative = parseGcode(gcode("M83", "G1 X5 Y5 Z0.2", "G91", "G1 X10 E1", "G1 Y10 E1"));
    expect(segment(relative.positions, 1)).toEqual([15, 5, 0.2, 15, 15, 0.2]);
    const inches = parseGcode(gcode("G20", "M83", "G1 Z0.01", "G1 X1 Y0 E0.1"));
    expect(segment(inches.positions, 0)).toEqual([0, 0, 0.254, 25.4, 0, 0.254]);
  });

  it("lignes numérotées, sommes de contrôle, minuscules, mots collés, commentaires", () => {
    const result = parseGcode(
      gcode(
        "N1 M83*12",
        "N2 G1 Z0.2*45",
        "g1x10y0e1 ; extrusion",
        "G1 X20 ; E5 dans le commentaire",
        "  G1   X  30   E1",
      ),
    );
    expect(result.segments).toBe(2);
    expect(segment(result.positions, 1)).toEqual([20, 0, 0.2, 30, 0, 0.2]);
  });

  it("macros Klipper et commandes inconnues : ignorées, sans bouger la buse", () => {
    const result = parseGcode(
      gcode(
        "PRINT_START BED=60 EXTRUDER=215",
        "EXCLUDE_OBJECT_START NAME=piece",
        "TURN_OFF_HEATERS",
        "M104 S215",
        "M83",
        "G1 Z0.2",
        "G1 X10 E1",
      ),
    );
    expect(result.segments).toBe(1);
    expect(segment(result.positions, 0)).toEqual([0, 0, 0.2, 10, 0, 0.2]);
  });

  it("G28 : retour à l'origine des axes nommés, ou de tous", () => {
    const result = parseGcode(gcode("M83", "G1 X50 Y50 Z5", "G28 X", "G1 Y60 E1"));
    expect(segment(result.positions, 0)).toEqual([0, 50, 5, 0, 60, 5]);
  });
});

describe("parseGcode : arcs (G2/G3)", () => {
  it("quart de cercle par I/J, découpé en segments d'environ 1 mm, extrusion répartie", () => {
    const result = parseGcode(gcode("M83", "G1 X10 Y0 Z0.2", "G3 X0 Y10 I-10 J0 E2"));
    // Longueur 15,7 mm → 16 segments.
    expect(result.segments).toBe(16);
    expect(segment(result.positions, 15).slice(3)).toEqual([0, 10, 0.2]);
    const mid = segment(result.positions, 7);
    expect(Math.hypot(mid[3] ?? 0, mid[4] ?? 0)).toBeCloseTo(10, 3);
    const total = Array.from(result.extrusions).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(2, 5);
    expect(result.stats.arcs).toBe(1);
  });

  it("sens horaire (G2) et cercle complet (fin = début)", () => {
    const cw = parseGcode(gcode("M83", "G1 X10 Y0 Z0.2", "G2 X0 Y-10 I-10 J0 E1"));
    const first = segment(cw.positions, 0);
    expect(first[4]).toBeLessThan(0); // descend : sens horaire
    const full = parseGcode(gcode("M83", "G1 X10 Y0 Z0.2", "G3 X10 Y0 I-10 J0 E1"));
    expect(full.segments).toBe(63); // 2π × 10 mm
  });

  it("arc par rayon R ; rayon trop petit : signalé, sans segment", () => {
    const byRadius = parseGcode(gcode("M83", "G1 X0 Y0 Z0.2", "G3 X10 Y10 R10 E1"));
    const end = segment(byRadius.positions, byRadius.segments - 1);
    expect(end.slice(3)).toEqual([10, 10, 0.2]);
    const invalid = parseGcode(gcode("M83", "G1 X0 Y0 Z0.2", "G2 X100 Y0 R1 E1"));
    expect(invalid.segments).toBe(0);
    expect(invalid.warnings.map((w) => w.code)).toEqual(["gcode.arcInvalid"]);
  });

  it("rayon aberrant : nombre de segments borné", () => {
    const result = parseGcode(gcode("M83", "G1 X0 Y0 Z0.2", "G3 X0 Y0 I1000000 J0 E1"));
    expect(result.segments).toBe(2000);
  });
});

describe("parseGcode : rôles et outils", () => {
  it.each([
    [";TYPE:External perimeter", "outer-wall"],
    [";TYPE:Internal infill", "infill"],
    [";TYPE:Outer wall", "outer-wall"],
    [";TYPE:Sparse infill", "infill"],
    ["; FEATURE: Top surface", "top-surface"],
    [";TYPE:WALL-OUTER", "outer-wall"],
    [";TYPE:SKIN", "solid-infill"],
    [";TYPE:SUPPORT-INTERFACE", "support-interface"],
    [";TYPE:Quelque chose", "other"],
  ] as const)("%s → %s", (comment, expected) => {
    const result = parseGcode(gcode("M83", "G1 Z0.2", comment, "G1 X10 E1"));
    expect(result.roles[0]).toBe(role(expected));
  });

  it("changement d'outil (T0–T15) compté et porté par chaque segment", () => {
    const result = parseGcode(
      gcode("M83", "G1 Z0.2", "T0", "G1 X10 E1", "T1", "G1 X20 E1", "T1", "T99", "G1 X30 E1"),
    );
    expect(Array.from(result.tools)).toEqual([0, 1, 1]);
    expect(result.stats.toolChanges).toBe(1);
  });

  it("roleIndex tolère casse, tirets et espaces", () => {
    expect(roleIndex("  wall_outer ")).toBe(role("outer-wall"));
    expect(roleIndex("SUPPORT-INTERFACE")).toBe(role("support-interface"));
  });
});

describe("parseGcode : limites et entrées hostiles (EP-16.02)", () => {
  it("limite de segments : lecture arrêtée et signalée", () => {
    const lines = ["M83", "G1 Z0.2"];
    for (let k = 1; k <= 100; k++) lines.push(`G1 X${k} E0.1`);
    const result = parseGcode(gcode(...lines), { maxSegments: 10 });
    expect(result.segments).toBe(10);
    expect(result.truncated).toBe(true);
    expect(result.warnings.map((w) => w.code)).toContain("gcode.segmentLimit");
  });

  it("vide, binaire, nombres démesurés : pas d'exception", () => {
    expect(parseGcode(new Uint8Array()).segments).toBe(0);
    expect(parseGcode(Uint8Array.from({ length: 4096 }, (_, k) => k % 256)).segments).toBe(0);
    const huge = parseGcode(gcode("M83", `G1 X${"9".repeat(400)} E1`, "G1 Y5 E1"));
    expect(huge.warnings.map((w) => w.code)).toContain("gcode.nonFinite");
    expect(huge.segments).toBe(1);
  });

  it("fichier de plusieurs couches : une couche par hauteur, aucun segment perdu", () => {
    const lines = ["M83"];
    for (let l = 1; l <= 50; l++) {
      lines.push(`G1 Z${(l * 0.2).toFixed(1)}`);
      for (let k = 1; k <= 100; k++) lines.push(`G1 X${k} Y${l} E0.01`);
    }
    const result = parseGcode(gcode(...lines));
    expect(result.layerStarts).toHaveLength(50);
    expect(result.segments).toBe(5000);
  });
});
