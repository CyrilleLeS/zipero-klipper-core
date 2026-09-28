// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from "vitest";
import { printMesh, printProbedMatrix } from "./klipper-format.fixture";
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
    expect([0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 0.51].map((range) => gradeFlatness(range))).toEqual([
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

describe("analyzeBedMesh — surface interpolée", () => {
  it("recalcule la surface d'un profil avec ses propres réglages", () => {
    const bowl = grid((u, v) => 0.1 * (u * u + v * v));
    const [mesh] = report(printerCfg("185, 225", profileBlock(bowl))).meshes;
    expect(mesh?.interpolated).toMatchObject({ algorithm: "lagrange", source: "computed" });
    expect([mesh?.interpolated?.grid.cols, mesh?.interpolated?.grid.rows]).toEqual([13, 13]);
  });

  it("reprend la grille imprimée par Klipper dans une sortie console", () => {
    const text = `${printProbedMatrix(grid(() => 0))}\n${printMesh({
      mesh: Array.from({ length: 13 }, () => Array.from({ length: 13 }, () => 0)),
      algorithm: "bicubic",
    })}`;
    const [mesh] = report(text).meshes;
    expect(mesh?.interpolated).toMatchObject({ algorithm: "bicubic", source: "klipper" });
  });

  it("calcule la surface par défaut d'une sortie console sans grille interpolée", () => {
    const [mesh] = report(printProbedMatrix(grid(() => 0))).meshes;
    expect(mesh?.interpolated?.source).toBe("computed");
  });
});

describe("gradeFlatness et seuils par imprimante", () => {
  it("applique des seuils réglables", () => {
    const strict = { excellent: 0.05, good: 0.1, fair: 0.2 };
    expect(gradeFlatness(0.15, strict)).toBe("fair");
    const value = report(
      printProbedMatrix(
        grid(() => 0).map((row, r) => row.map((_, c) => (r === 0 && c === 0 ? 0.15 : 0))),
      ),
    );
    expect(value.meshes[0]?.grade).toBe("good");
    const strictReport = analyzeBedMesh(
      printProbedMatrix(
        grid(() => 0).map((row, r) => row.map((_, c) => (r === 0 && c === 0 ? 0.15 : 0))),
      ),
      { flatness: strict },
    );
    expect(strictReport.ok && strictReport.value.meshes[0]?.grade).toBe("fair");
  });
});

describe("analyzeBedMesh — assistant de vis", () => {
  const withScrews = (section: string) =>
    printerCfg("185, 225", profileBlock(grid((u) => 0.2 * u))).replace(
      "[bed_mesh]",
      `${section}\n[bed_mesh]`,
    );

  it("calcule les réglages depuis [screws_tilt_adjust] (sonde au-dessus de la vis)", () => {
    const cfg = withScrews(
      [
        "[screws_tilt_adjust]",
        "screw1: 74, 36",
        "screw1_name: avant gauche",
        "screw2: 234, 36",
        "screw2_name: avant droite",
        "screw3: 234, 196",
        "screw4: 74, 196",
        "screw_thread: CW-M4",
      ].join("\n"),
    );
    const [mesh] = report(cfg).meshes;
    expect(mesh?.screws).toMatchObject({
      source: "screws_tilt_adjust",
      thread: "CW-M4",
      threadKnown: true,
    });
    // Sonde à −44 / −6 : lecture en (30, 30) et (190, 30), bords gauche et droit du maillage.
    const [left, right] = mesh?.screws?.readings ?? [];
    expect(left?.z).toBeCloseTo(-0.2, 6);
    expect(right?.z).toBeCloseTo(0.2, 6);
    // Droite plus haute de 0,4 mm : descendre la vis de droite, 0,4 / 0,7 tour, sens antihoraire.
    expect(mesh?.screws?.adjustments[1]).toMatchObject({ direction: "CCW", label: "00:34" });
    const diagnostics = report(cfg).diagnostics;
    expect(diagnostics.find((d) => d.code === "bedMesh.screwsAdjust")?.params).toMatchObject({
      count: 2,
    });
  });

  it("[bed_screws] : lecture à l'aplomb de la vis, filetage supposé", () => {
    const [mesh] = report(
      withScrews(
        ["[bed_screws]", "screw1: 30, 30", "screw2: 190, 30", "screw3: 190, 190"].join("\n"),
      ),
    ).meshes;
    expect(mesh?.screws).toMatchObject({
      source: "bed_screws",
      thread: "CW-M3",
      threadKnown: false,
    });
    expect(mesh?.screws?.readings[1]?.z).toBeCloseTo(0.2, 6);
  });
});

describe("analyzeBedMesh — bruit et PROBE_ACCURACY", () => {
  it("signale un bruit réparti (vérifier la sonde), pas un point isolé", () => {
    // Damier ±0,06 mm sur 5 × 5 : bruit réparti que la forme n'explique pas.
    const noisy = Array.from({ length: 5 }, (_, r) =>
      Array.from({ length: 5 }, (_, c) => ((r + c) % 2 === 0 ? 0.06 : -0.06)),
    );
    const codes = report(printProbedMatrix(noisy)).diagnostics.map((d) => d.code);
    expect(codes).toContain("bedMesh.noisy");
    expect(analyzeBedMesh(printProbedMatrix(noisy), { noise: 0.2 }).ok).toBe(true);
    const quiet = analyzeBedMesh(printProbedMatrix(noisy), { noise: 0.2 });
    expect(quiet.ok && quiet.value.diagnostics.map((d) => d.code)).not.toContain("bedMesh.noisy");
  });

  it("reconnaît une sortie PROBE_ACCURACY et donne le verdict de répétabilité", () => {
    const lines = [
      "// PROBE_ACCURACY at X:117.500 Y:117.500 Z:10.000 (samples=10 retract=2.000 speed=5.0 lift_speed=5.0)",
      ...Array.from(
        { length: 10 },
        (_, i) => `// probe at 117.500,117.500 is z=${(2.5 + (i % 2) * 0.005).toFixed(6)}`,
      ),
      "// probe accuracy results: maximum 2.505000, minimum 2.500000, range 0.005000, average 2.502500, median 2.502500, standard deviation 0.002500",
    ];
    const value = report(lines.join("\n"));
    expect(value.input).toBe("probe-accuracy");
    expect(value.probeAccuracy?.[0]?.assessment.verdict).toBe("good");
    expect(value.diagnostics[0]).toMatchObject({
      code: "bedMesh.probeGood",
      params: { samples: 10, range: 0.005 },
    });
  });
});
