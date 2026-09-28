// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from "vitest";
import { parseMeshProfiles } from "./profiles";

/** Bloc SAVE_CONFIG tel que Klipper 0.13 l'écrit (configfile + BedMeshProfileManager.save_profile). */
const printerCfg = `[printer]
kinematics: cartesian

[bed_mesh]
speed: 120
mesh_min: 30, 30
mesh_max: 200, 200
probe_count: 3, 3

#*# <---------------------- SAVE_CONFIG ---------------------->
#*# DO NOT EDIT THIS BLOCK OR BELOW. The contents are auto-generated.
#*#
#*# [probe]
#*# z_offset = 1.915
#*#
#*# [bed_mesh default]
#*# version = 1
#*# points =
#*# \t  -0.057500, -0.030000, 0.012500
#*# \t  -0.022500, 0.000000, 0.027500
#*# \t  0.005000, 0.035000, 0.070000
#*# x_count = 3
#*# y_count = 3
#*# mesh_x_pps = 2
#*# mesh_y_pps = 2
#*# algo = lagrange
#*# tension = 0.2
#*# min_x = 30.0
#*# max_x = 200.0
#*# min_y = 30.0
#*# max_y = 200.0
#*#
#*# [bed_mesh chaud]
#*# version = 1
#*# points =
#*# \t  0.010000, 0.020000, 0.030000
#*# \t  0.010000, 0.020000, 0.030000
#*# \t  0.010000, 0.020000, 0.030000
#*# x_count = 3
#*# y_count = 3
#*# mesh_x_pps = 2
#*# mesh_y_pps = 2
#*# algo = lagrange
#*# tension = 0.2
#*# min_x = 30.0
#*# max_x = 200.0
#*# min_y = 30.0
#*# max_y = 200.0
`;

describe("parseMeshProfiles", () => {
  it("lit tous les profils du bloc SAVE_CONFIG, sans prendre la section [bed_mesh]", () => {
    const result = parseMeshProfiles(printerCfg);
    if (!result.ok) throw new Error("échec inattendu");
    expect(result.warnings).toEqual([]);
    expect(result.value.map((p) => p.name)).toEqual(["default", "chaud"]);
    const [def] = result.value;
    expect(def).toMatchObject({ line: 16, autosave: true });
    expect(def?.probed).toEqual({
      rows: 3,
      cols: 3,
      values: [
        [-0.0575, -0.03, 0.0125],
        [-0.0225, 0, 0.0275],
        [0.005, 0.035, 0.07],
      ],
    });
    expect(def?.params).toEqual({
      minX: 30,
      maxX: 200,
      minY: 30,
      maxY: 200,
      xCount: 3,
      yCount: 3,
      xPps: 2,
      yPps: 2,
      algorithm: "lagrange",
      tension: 0.2,
    });
  });

  const profile = (overrides: Record<string, string | null>) => {
    const options: Record<string, string> = {
      version: "1",
      points: "\n  0.1, 0.2, 0.3\n  0.1, 0.2, 0.3\n  0.1, 0.2, 0.3",
      x_count: "3",
      y_count: "3",
      mesh_x_pps: "2",
      mesh_y_pps: "2",
      algo: "bicubic",
      tension: "0.2",
      min_x: "10",
      max_x: "100",
      min_y: "10",
      max_y: "100",
    };
    for (const [key, value] of Object.entries(overrides)) {
      if (value === null) delete options[key];
      else options[key] = value;
    }
    return `[bed_mesh test]\n${Object.entries(options)
      .map(([key, value]) => `${key} = ${value}`)
      .join("\n")}`;
  };

  it("accepte un profil écrit à la main dans printer.cfg (hors SAVE_CONFIG)", () => {
    const result = parseMeshProfiles(profile({}));
    expect(result.ok && result.value[0]?.autosave).toBe(false);
  });

  it("ignore un profil d'une autre version, comme Klipper", () => {
    const result = parseMeshProfiles(profile({ version: "0" }));
    expect(result.ok ? null : result.error).toEqual({
      code: "profile.unsupported-version",
      line: 2,
      params: { profile: "test", version: "0" },
    });
  });

  it("signale une option manquante ou invalide", () => {
    const missing = parseMeshProfiles(profile({ tension: null }));
    expect(missing.ok ? null : missing.error).toMatchObject({
      code: "profile.missing-option",
      params: { option: "tension" },
    });
    const invalid = parseMeshProfiles(profile({ x_count: "trois" }));
    expect(invalid.ok ? null : invalid.error).toMatchObject({
      code: "profile.invalid-option",
      params: { option: "x_count" },
    });
  });

  it("traite une version absente comme la version 0 (incompatible), comme Klipper", () => {
    const result = parseMeshProfiles(profile({ version: null }));
    expect(result.ok ? null : result.error).toEqual({
      code: "profile.unsupported-version",
      line: 1,
      params: { profile: "test", version: "0" },
    });
  });

  it("signale l'absence des points ou un algorithme vide", () => {
    const noPoints = parseMeshProfiles(profile({ points: null }));
    expect(noPoints.ok ? null : noPoints.error).toMatchObject({
      code: "profile.missing-option",
      params: { option: "points" },
    });
    const emptyAlgo = parseMeshProfiles(profile({ algo: "" }));
    expect(emptyAlgo.ok ? null : emptyAlgo.error).toMatchObject({
      code: "profile.invalid-option",
      params: { option: "algo" },
    });
  });

  it("signale des points incohérents avec x_count / y_count", () => {
    const result = parseMeshProfiles(profile({ x_count: "4" }));
    expect(result.ok ? null : result.error).toMatchObject({
      code: "profile.points-mismatch",
      params: { expectedRows: 3, expectedCols: 4 },
    });
    const nonNumeric = parseMeshProfiles(
      profile({ points: "\n  0.1, x, 0.3\n  0.1, 0.2, 0.3\n  0.1, 0.2, 0.3" }),
    );
    expect(nonNumeric.ok ? null : nonNumeric.error.code).toBe("profile.points-mismatch");
  });

  it("garde les profils valides et avertit pour les autres", () => {
    const result = parseMeshProfiles(`${printerCfg}\n[bed_mesh ancien]\nversion = 0`);
    expect(result.ok && result.value.length).toBe(2);
    expect(result.warnings.map((w) => w.code)).toEqual(["profile.unsupported-version"]);
  });

  it("aucun profil", () => {
    expect(parseMeshProfiles("[printer]\nkinematics: corexy")).toEqual({
      ok: false,
      error: { code: "profile.none-found" },
      warnings: [],
    });
  });
});
