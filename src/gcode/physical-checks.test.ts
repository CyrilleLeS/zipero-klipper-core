// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from "vitest";
import { readGcodeFacts } from "./klipper-checks";
import { readGcodeMetadata } from "./metadata";
import { parseGcode } from "./parse";
import { checkPhysics, MATERIAL_TEMPERATURES, materialOf } from "./physical-checks";

// Le paquet autonome n'a ni types Node ni DOM (pas de TextEncoder) ; le G-code est en ASCII.
const ascii = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));
const gcode = (...lines: string[]) => ascii(`${lines.join("\n")}\n`);

const run = (bytes: Uint8Array, context = {}) =>
  checkPhysics(parseGcode(bytes), readGcodeMetadata(bytes), readGcodeFacts(bytes), context);

/** Deux couches de 10 lignes de 20 mm, à la vitesse donnée pour la première couche (mm/s). */
const twoLayers = (firstSpeed: number, extraHeader: string[] = []) =>
  gcode(
    ...extraHeader,
    "M83",
    "G1 Z0.2",
    ...Array.from({ length: 10 }, (_, k) => `G1 X${(k % 2) * 20} Y${k} E0.8 F${firstSpeed * 60}`),
    "G1 Z0.4",
    ...Array.from({ length: 10 }, (_, k) => `G1 X${(k % 2) * 20} Y${k} E0.8 F3000`),
  );

describe("règles physiques du G-code (EP-04.11)", () => {
  it("première couche à 100 mm/s : signalée ; à 30 mm/s : rien", () => {
    expect(run(twoLayers(100))).toEqual([
      { code: "gcode.first-layer-fast", severity: "warning", params: { speed: 100, limit: 60 } },
    ]);
    expect(run(twoLayers(30))).toEqual([]);
  });

  it("débit au-delà de la capacité déclarée par le trancheur ; sans déclaration : rien", () => {
    // 0,8 mm de filament de 1,75 mm sur 20 mm à 50 mm/s : environ 3,8 mm³/s.
    const declared = run(twoLayers(50, ["; filament_max_volumetric_speed = 2"]));
    expect(declared).toEqual([
      {
        code: "gcode.flow-over-capacity",
        severity: "warning",
        params: expect.objectContaining({ capacity: 2, share: 100 }),
      },
    ]);
    expect((declared[0]?.params?.["flow"] as number) > 3).toBe(true);
    expect(run(twoLayers(50, ["; filament_max_volumetric_speed = 0"]))).toEqual([]);
    expect(run(twoLayers(50, ["; filament_max_volumetric_speed = 15"]))).toEqual([]);
  });

  it("extrusion hors de la course des axes : erreur par axe dépassé", () => {
    const checks = run(
      gcode("M83", "G1 Z0.2", "G1 X5 Y5", "G1 X245 Y5 E5 F1800", "G1 X245 Y-3 E1"),
      { travel: { minX: 0, maxX: 235, minY: 0, maxY: 235, maxZ: 250 } },
    );
    expect(checks).toEqual([
      {
        code: "gcode.out-of-volume",
        severity: "error",
        params: { axis: "X", side: "max", value: 245, limit: 235 },
      },
      {
        code: "gcode.out-of-volume",
        severity: "error",
        params: { axis: "Y", side: "min", value: -3, limit: 0 },
      },
    ]);
  });

  it("températures du matériau déclaré : commandes du trancheur ou paramètres de macro", () => {
    const pla = run(
      gcode("; filament_type = PLA;PETG", "M104 S260", "PRINT_START BED=95", "M83", "G1 X1 Y1 E1"),
    );
    expect(pla).toEqual([
      {
        code: "gcode.nozzle-temp-material",
        severity: "warning",
        params: { material: "PLA", temperature: 260, min: 185, max: 230 },
      },
      {
        code: "gcode.bed-temp-material",
        severity: "info",
        params: { material: "PLA", temperature: 95, min: 55, max: 60 },
      },
    ]);
    // Dans la plage (tolérance comprise), ou matériau inconnu du tableau : rien.
    expect(
      run(
        gcode("; filament_type = PETG", "PRINT_START EXTRUDER_TEMP=240 BED_TEMP=80", "G1 X1 Y1 E1"),
      ),
    ).toEqual([]);
    expect(run(gcode("; filament_type = PVA", "M104 S300", "G1 X1 Y1 E1"))).toEqual([]);
  });

  it("noms de matériau des trancheurs ramenés au tableau", () => {
    expect(
      [
        "PLA+",
        "PET",
        "PETG-CF",
        "PA12-CF",
        "NYLON",
        "PC-ABS",
        "FLEX",
        "TPE",
        "HIPS",
        undefined,
      ].map(materialOf),
    ).toEqual(["PLA", "PETG", "PETG", "PA", "PA", "PC", "TPU", "TPU", undefined, undefined]);
    for (const range of Object.values(MATERIAL_TEMPERATURES)) {
      expect(range.nozzle[0]).toBeLessThanOrEqual(range.nozzle[1]);
      expect(range.bed[0]).toBeLessThanOrEqual(range.bed[1]);
    }
  });

  it("métadonnées : matériau et débit maximal lus dans le bloc de réglages", () => {
    const meta = readGcodeMetadata(
      gcode("; filament_type = abs;ABS", "; filament_max_volumetric_speed = 11,11"),
    );
    expect(meta).toMatchObject({ filamentType: "ABS", maxVolumetricSpeed: 11 });
  });
});

describe("règles physiques : cas limites", () => {
  const travel = { minX: 0, maxX: 235, minY: 0, maxY: 235, maxZ: 10 };

  it("aucune extrusion : rien, même avec course et capacité connues", () => {
    expect(
      run(gcode("; filament_max_volumetric_speed = 5", "G0 X300 Y300 Z50"), { travel }),
    ).toEqual([]);
  });

  it("une seule couche, rapide ; hauteur au-delà de la course en Z ; course sans Z", () => {
    const bytes = gcode("M83", "G1 Z12", "G1 X10 Y10 E1 F6000", "G1 X20 Y10 E1");
    expect(run(bytes, { travel }).map((c) => [c.code, c.params?.["axis"] ?? ""])).toEqual([
      ["gcode.first-layer-fast", ""],
      ["gcode.out-of-volume", "Z"],
    ]);
    const { maxZ: _ignored, ...noZ } = travel;
    expect(run(bytes, { travel: noZ }).map((c) => c.code)).toEqual(["gcode.first-layer-fast"]);
  });

  it("buse trop froide (M109) ; plateau dans la plage (M190) ; paramètres de macro illisibles", () => {
    const checks = run(
      gcode(
        "; filament_type = PETG",
        "M190 S80",
        "M109 S190",
        "PRINT_START EXTRUDER=abc BED=0 HOTEND=-5",
        "G1 X1 Y1 E1",
      ),
    );
    expect(checks).toEqual([
      {
        code: "gcode.nozzle-temp-material",
        severity: "warning",
        params: { material: "PETG", temperature: 190, min: 215, max: 270 },
      },
    ]);
  });

  it("plateau trop froid pour l'ABS ; diamètre de 2,85 mm déclaré pris en compte pour le débit", () => {
    const abs = run(gcode("; filament_type = ABS", "M140 S50", "M104 S240", "G1 X1 Y1 E1"));
    expect(abs.map((c) => [c.code, c.params?.["temperature"]])).toEqual([
      ["gcode.bed-temp-material", 50],
    ]);
    // Même G-code : 3,8 mm³/s en 1,75 mm, environ 10 mm³/s en 2,85 mm (capacité 8).
    const thick = run(
      twoLayers(50, ["; filament_diameter = 2.85", "; filament_max_volumetric_speed = 8"]),
    );
    expect(thick.map((c) => c.code)).toEqual(["gcode.flow-over-capacity"]);
    expect(run(twoLayers(50, ["; filament_max_volumetric_speed = 8"]))).toEqual([]);
  });
});
