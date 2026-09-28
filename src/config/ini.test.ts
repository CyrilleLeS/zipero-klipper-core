// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from "vitest";
import { parseConfig } from "./ini";

const optionsOf = (source: string, section: string) =>
  Object.fromEntries(
    [
      ...(parseConfig(source)
        .find((s) => s.name === section)
        ?.options.values() ?? []),
    ].map((o) => [o.name, o.value]),
  );

describe("parseConfig", () => {
  it("lit sections et options avec « : » ou « = », clés en minuscules", () => {
    const cfg = "[printer]\nKinematics: cartesian\nmax_velocity = 300\n\n[extruder]\nstep_pin: PA4";
    expect(optionsOf(cfg, "printer")).toEqual({ kinematics: "cartesian", max_velocity: "300" });
    expect(optionsOf(cfg, "extruder")).toEqual({ step_pin: "PA4" });
  });

  it("conserve les numéros de ligne des sections et options", () => {
    const [section] = parseConfig("# entête\n[stepper_x]\nstep_pin: PB13");
    expect(section?.line).toBe(2);
    expect(section?.options.get("step_pin")?.line).toBe(3);
  });

  it("ignore les commentaires de ligne et de fin de ligne (# et ;)", () => {
    const cfg =
      "[probe]\n# commentaire\n; autre\nx_offset: -44 # à gauche\ny_offset: -6 ;avant\npin: ^PB7#pas un commentaire";
    expect(optionsOf(cfg, "probe")).toEqual({
      x_offset: "-44",
      y_offset: "-6",
      pin: "^PB7#pas un commentaire",
    });
  });

  it("assemble les valeurs sur plusieurs lignes indentées", () => {
    const cfg =
      "[gcode_macro START]\ngcode:\n  G28\n  {% if x %}\n    G1 Z5\n  {% endif %}\nvariable_a: 1";
    expect(optionsOf(cfg, "gcode_macro START")).toEqual({
      gcode: "G28\n{% if x %}\nG1 Z5\n{% endif %}",
      variable_a: "1",
    });
  });

  it("fusionne une section répétée ; la dernière valeur d'une option l'emporte (strict=False)", () => {
    const cfg = "[bed_mesh]\nspeed: 100\n[bed_mesh]\nspeed: 120\nhorizontal_move_z: 5";
    expect(optionsOf(cfg, "bed_mesh")).toEqual({ speed: "120", horizontal_move_z: "5" });
  });

  it("lit le bloc SAVE_CONFIG (#*#) avec tabulations, qui l'emporte sur la configuration", () => {
    const cfg = [
      "[probe]",
      "z_offset: 1.0",
      "",
      "#*# <---------------------- SAVE_CONFIG ---------------------->",
      "#*# DO NOT EDIT THIS BLOCK OR BELOW. The contents are auto-generated.",
      "#*#",
      "#*# [probe]",
      "#*# z_offset = 1.915",
      "#*#",
      "#*# [bed_mesh default]",
      "#*# version = 1",
      "#*# points =",
      "#*# \t  -0.057500, -0.030000",
      "#*# \t  0.005000, 0.035000",
    ].join("\n");
    const sections = parseConfig(cfg);
    const probe = sections.find((s) => s.name === "probe")?.options.get("z_offset");
    expect(probe).toMatchObject({ value: "1.915", autosave: true, line: 8 });
    expect(optionsOf(cfg, "bed_mesh default")).toEqual({
      version: "1",
      points: "-0.057500, -0.030000\n0.005000, 0.035000",
    });
  });

  it("ignore les lignes hors section ou sans délimiteur", () => {
    expect(parseConfig("orpheline: 1\n[a]\nlignesansdelimiteur\nb: 2")).toHaveLength(1);
    expect(optionsOf("orpheline: 1\n[a]\nlignesansdelimiteur\nb: 2", "a")).toEqual({ b: "2" });
  });
});
