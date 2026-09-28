// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from "vitest";
import { interpolateMesh } from "./mesh/interpolate";
import { analyzeBedMesh, type BedMeshReport } from "./mesh/report";
import { parseProbeAccuracy } from "./probe/accuracy";

/**
 * Entrées hostiles ou absurdes (EP-16.02) : l'analyse doit se terminer vite, sans exception ni
 * explosion mémoire. Avant les limites de `limits.ts`, un `mesh_pps` démesuré épuisait 4 Go de
 * mémoire en 20 s ; un `probe_count` démesuré aurait généré 10 milliards de points.
 */

const printer = (bedMesh: string) =>
  `[printer]\nkinematics: cartesian\n[stepper_x]\nposition_max: 300\n[stepper_y]\nposition_max: 300\n[probe]\nx_offset: 0\ny_offset: 0\n[bed_mesh]\nmesh_min: 10,10\nmesh_max: 290,290\n${bedMesh}\n`;

const savedProfile = (cols: number, rows: number, pps: number, algo: string) =>
  [
    printer("probe_count: 5, 5"),
    "#*# <---------------------- SAVE_CONFIG ---------------------->",
    "#*# [bed_mesh default]",
    "#*# version = 1",
    "#*# points =",
    ...Array.from(
      { length: rows },
      (_, j) =>
        `#*# \t${Array.from({ length: cols }, (_, i) => ((i + j) / 1000).toFixed(3)).join(", ")}`,
    ),
    `#*# x_count = ${cols}`,
    `#*# y_count = ${rows}`,
    `#*# mesh_x_pps = ${pps}`,
    `#*# mesh_y_pps = ${pps}`,
    `#*# algo = ${algo}`,
    "#*# tension = 0.2",
    "#*# min_x = 10",
    "#*# max_x = 290",
    "#*# min_y = 10",
    "#*# max_y = 290",
  ].join("\n");

/** Exécute et chronomètre ; échoue si l'analyse lève une exception. */
function timed<T>(run: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = run();
  return { value, ms: performance.now() - start };
}

const report = (text: string): BedMeshReport => {
  const result = analyzeBedMesh(text);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
};

describe("entrées hostiles", () => {
  it("probe_count démesuré : zone non recalculée, signalée", () => {
    const { value, ms } = timed(() => report(printer("probe_count: 100000, 100000")));
    expect(ms).toBeLessThan(1000);
    expect(value.diagnostics.map((d) => d.code)).toContain("bedMesh.probeCountTooHigh");
  });

  it("round_probe_count démesuré", () => {
    const { value, ms } = timed(() =>
      report(printer("mesh_radius: 100\nmesh_origin: 0,0\nround_probe_count: 99999")),
    );
    expect(ms).toBeLessThan(1000);
    expect(value.diagnostics.map((d) => d.code)).toContain("bedMesh.probeCountTooHigh");
  });

  it("mesh_pps démesuré : maillage analysé, sans surface interpolée", () => {
    const { value, ms } = timed(() => report(savedProfile(10, 10, 100_000, "bicubic")));
    expect(ms).toBeLessThan(1000);
    expect(value.meshes).toHaveLength(1);
    expect(value.meshes[0]?.interpolated).toBeUndefined();
  });

  it("grande grille (300 × 300) avec mesh_pps : surface interpolée refusée", () => {
    const { value, ms } = timed(() => report(savedProfile(300, 300, 4, "bicubic")));
    expect(ms).toBeLessThan(5000);
    expect(value.meshes[0]?.interpolated).toBeUndefined();
    expect(value.meshes[0]?.metrics.range).toBeCloseTo(0.598, 3);
  });

  it("mesh_pps négatif ou non entier : pas d'interpolation, pas d'exception", () => {
    const grid = { cols: 5, rows: 5, values: Array.from({ length: 5 }, () => [0, 0, 0, 0, 0]) };
    for (const xPps of [-5, 2.5, Number.NaN]) {
      expect(interpolateMesh(grid, { xPps, yPps: 2, algorithm: "lagrange", tension: 0.2 })).toEqual(
        {
          ok: false,
          code: "interpolate.invalid-pps",
        },
      );
    }
  });

  it.each([
    ["ligne de 4 Mo", `Mesh Leveling Probed Z positions:\n${"0.1 ".repeat(1_000_000)}`],
    [
      "20 000 profils vides",
      Array.from({ length: 20_000 }, (_, i) => `[bed_mesh p${i}]\nversion = 1`).join("\n"),
    ],
    ["2 millions d'espaces", `${" ".repeat(2_000_000)}x`],
    ["2 millions de crochets", "[".repeat(2_000_000)],
    ["nombre d'un million de chiffres", `probe accuracy results: maximum ${"1".repeat(1_000_000)}`],
  ])("%s : se termine vite", (_, text) => {
    const { ms } = timed(() => {
      analyzeBedMesh(text);
      parseProbeAccuracy(text);
    });
    expect(ms).toBeLessThan(3000);
  });
});
