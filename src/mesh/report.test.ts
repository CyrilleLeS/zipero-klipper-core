// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from "vitest";
import { printProbedMatrix } from "./klipper-format.fixture";
import { analyzeBedMesh, type BedMeshReport, gradeFlatness } from "./report";

const report = (text: string): BedMeshReport => {
  const result = analyzeBedMesh(text);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
};

/** Grille 5 × 5 échantillonnant z(u, v), u et v dans [-1, 1]. */
const grid = (z: (u: number, v: number) => number) =>
  Array.from({ length: 5 }, (_, row) =>
    Array.from({ length: 5 }, (_, col) => Math.round(z(col / 2 - 1, row / 2 - 1) * 1e6) / 1e6),
  );

const profileBlock = (values: number[][], name = "default") =>
  [
    `#*# [bed_mesh ${name}]`,
    "#*# version = 1",
    "#*# points =",
    ...values.map((row) => `#*# \t  ${row.map((v) => v.toFixed(6)).join(", ")}`),
    "#*# x_count = 5",
    "#*# y_count = 5",
    "#*# mesh_x_pps = 2",
    "#*# mesh_y_pps = 2",
    "#*# algo = lagrange",
    "#*# tension = 0.2",
    "#*# min_x = 30.0",
    "#*# max_x = 190.0",
    "#*# min_y = 30.0",
    "#*# max_y = 190.0",
  ].join("\n");

const printerCfg = (meshMax: string, profiles = "") =>
  [
    "[printer]",
    "kinematics: cartesian",
    "[stepper_x]",
    "position_max: 235",
    "[stepper_y]",
    "position_max: 235",
    "[bltouch]",
    "x_offset: -44",
    "y_offset: -6",
    "[bed_mesh]",
    "mesh_min: 30, 30",
    `mesh_max: ${meshMax}`,
    "probe_count: 5, 5",
    "",
    "#*# <---------------------- SAVE_CONFIG ---------------------->",
    "#*# DO NOT EDIT THIS BLOCK OR BELOW. The contents are auto-generated.",
    "#*#",
    profiles,
  ].join("\n");

describe("analyzeBedMesh — sortie console", () => {
  it("analyse chaque maillage : métriques, forme, note, diagnostics triés", () => {
    const tilted = grid((u, v) => 0.3 * u + 0.1 * v);
    const value = report(printProbedMatrix(tilted));
    expect(value.input).toBe("console");
    expect(value.meshes).toHaveLength(1);
    const [mesh] = value.meshes;
    expect(mesh?.shape.shape).toBe("tilted");
    expect(mesh?.grade).toBe("poor"); // amplitude 0,8 mm
    expect(mesh?.geometry).toBeUndefined();
    expect(value.diagnostics.map((d) => [d.code, d.severity])).toEqual([
      ["bedMesh.rangeLarge", "warning"],
      ["bedMesh.tilted", "info"],
    ]);
    expect(value.diagnostics[1]?.params).toMatchObject({ riseX: 0.6, riseY: 0.2, confidence: 100 });
  });

  it("transmet l'erreur du lecteur quand rien n'est reconnu", () => {
    const result = analyzeBedMesh("rien d'utile ici");
    expect(result.ok ? null : result.error.code).toBe("mesh.none-found");
  });
});

describe("analyzeBedMesh — printer.cfg", () => {
  it("analyse les profils sauvegardés avec leur emprise et contrôle la zone sondée", () => {
    const bowl = grid((u, v) => 0.1 * (u * u + v * v));
    const value = report(printerCfg("185, 225", profileBlock(bowl)));
    expect(value.input).toBe("config");
    expect(value.meshes[0]).toMatchObject({ name: "default", grade: "good" });
    expect(value.meshes[0]?.geometry).toMatchObject({ minX: 30, maxX: 190 });
    expect(value.meshes[0]?.metrics.plane.slopeXPer100mm).not.toBeNull();
    expect(value.probeArea?.ok && value.probeArea.value.problems).toEqual([]);
    expect(value.diagnostics.map((d) => d.code)).toEqual(["bedMesh.bowl"]);
  });

  it("place la zone sondée hors course en tête, comme bloquante", () => {
    const flat = grid(() => 0.01);
    const value = report(printerCfg("200, 200", profileBlock(flat)));
    expect(value.diagnostics[0]).toMatchObject({
      code: "bedMesh.probeAreaOutOfRange",
      severity: "critical",
      params: { axis: "x", side: "max", excess: 9, suggested: 191, shape: "rectangular" },
    });
    expect(value.diagnostics.at(-1)?.code).toBe("bedMesh.flat");
  });

  it("contrôle la zone sondée même sans profil sauvegardé", () => {
    const value = report(printerCfg("200, 200"));
    expect(value.meshes).toEqual([]);
    expect(value.diagnostics.map((d) => d.code)).toEqual(["bedMesh.probeAreaOutOfRange"]);
  });

  it("échoue proprement si la configuration n'a ni profil ni zone contrôlable", () => {
    const result = analyzeBedMesh("[printer]\nkinematics: delta\n");
    expect(result.ok ? null : result.error.code).toBe("profile.none-found");
  });

  it("donne la forme et la diagonale d'une torsion", () => {
    const twisted = grid((u, v) => 0.2 * u * v);
    const value = report(printerCfg("185, 225", profileBlock(twisted)));
    const diagnostic = value.diagnostics.find((d) => d.code === "bedMesh.twisted");
    expect(diagnostic?.params).toMatchObject({ highDiagonal: "frontLeft-backRight", twist: 0.4 });
  });
});

describe("gradeFlatness", () => {
  it("applique les seuils 0,1 / 0,2 / 0,5 mm", () => {
    expect([0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 0.51].map(gradeFlatness)).toEqual([
      "excellent",
      "excellent",
      "good",
      "good",
      "fair",
      "fair",
      "poor",
    ]);
  });
});

describe("analyzeBedMesh — [bed_mesh] invalide", () => {
  it("signale comme bloquante une section que Klipper refuserait", () => {
    const value = report(printerCfg("20, 20"));
    expect(value.diagnostics).toEqual([
      {
        code: "bedMesh.meshConfigInvalid",
        severity: "critical",
        params: { reason: "probeArea.invalidMinMax" },
      },
    ]);
  });

  it("note un écart modéré et une forme irrégulière", () => {
    const bump = grid(() => 0);
    const row = bump[1];
    if (row) row[3] = 0.3;
    const value = report(printProbedMatrix(bump));
    expect(value.diagnostics.map((d) => d.code)).toEqual([
      "bedMesh.rangeModerate",
      "bedMesh.irregular",
    ]);
  });
});
