// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from "vitest";
import { type ConfigReadResult, parseConfig, readConfig } from "./ini";
import { dirname, joinPath, matchesGlob, normalizePath } from "./paths";

// Comportements vérifiés sur le vrai Klipper (klippy/configfile.py, commit 214fdb2877) :
// voir tooling/corpus-tests (oracle), non publié avec ce paquet.

const read = (files: Record<string, string>, main = "printer.cfg") =>
  readConfig({ files: new Map(Object.entries(files)), main });

const value = (result: ConfigReadResult, section: string, option: string) =>
  result.sections.find((s) => s.name === section)?.options.get(option);

const HEADER = [
  "#*# <---------------------- SAVE_CONFIG ---------------------->",
  "#*# DO NOT EDIT THIS BLOCK OR BELOW. The contents are auto-generated.",
  "#*#",
];

describe("readConfig : [include]", () => {
  const basic = {
    "printer.cfg": [
      "[printer]",
      "max_velocity: 300",
      "[include macros.cfg]",
      "[include hw/*.cfg]",
      "[printer]",
      "max_accel: 5000",
    ].join("\n"),
    "macros.cfg": "[printer]\nmax_velocity: 500",
    "hw/b.cfg": "[stepper_x]\nstep_pin: PB2",
    "hw/a.cfg": "[stepper_x]\nstep_pin: PB1\ndir_pin: PB0",
    "hw/.hidden.cfg": "[stepper_x]\nstep_pin: CACHE",
  };

  it("lit les fichiers inclus à leur place, jokers triés, fichiers cachés exclus", () => {
    const result = read(basic);
    expect(result.problems).toEqual([]);
    expect(result.filesRead).toEqual(["printer.cfg", "macros.cfg", "hw/a.cfg", "hw/b.cfg"]);
    // L'inclusion surcharge ce qui précède ; hw/b.cfg (lu après hw/a.cfg) l'emporte.
    expect(value(result, "printer", "max_velocity")).toMatchObject({
      value: "500",
      file: "macros.cfg",
      line: 2,
    });
    expect(value(result, "stepper_x", "step_pin")).toMatchObject({
      value: "PB2",
      file: "hw/b.cfg",
    });
    expect(value(result, "stepper_x", "dir_pin")?.value).toBe("PB0");
    expect(value(result, "printer", "max_accel")).toMatchObject({ file: "printer.cfg", line: 6 });
  });

  it("résout les chemins relatifs au fichier qui inclut (y compris « .. »)", () => {
    const result = read(
      {
        "config/printer.cfg": "[include sub/x.cfg]\n[printer]\nkinematics: none",
        "config/sub/x.cfg": "[include ../common.cfg]\n[include y.cfg]",
        "config/sub/y.cfg": "[stepper_y]\nstep_pin: PB2",
        "config/common.cfg": "[mcu]\nserial: /dev/ttyAMA0",
      },
      "config/printer.cfg",
    );
    expect(result.problems).toEqual([]);
    expect(result.filesRead).toEqual([
      "config/printer.cfg",
      "config/sub/x.cfg",
      "config/common.cfg",
      "config/sub/y.cfg",
    ]);
  });

  it("signale un fichier inclus absent, mais pas un joker sans résultat", () => {
    const result = read({
      "printer.cfg": "[include mainsail.cfg]\n[include macros/*.cfg]\n[printer]\nkinematics: none",
    });
    expect(result.problems).toEqual([
      {
        code: "config.include-missing",
        file: "printer.cfg",
        line: 1,
        params: { include: "mainsail.cfg" },
      },
    ]);
    expect(value(result, "printer", "kinematics")?.value).toBe("none");
  });

  it("signale une inclusion récursive à la ligne qui la provoque", () => {
    const result = read({
      "printer.cfg": "[printer]\nkinematics: none\n[include a.cfg]",
      "a.cfg": "[extruder]\nstep_pin: PA4\n[include printer.cfg]",
    });
    expect(result.problems).toEqual([
      {
        code: "config.include-recursive",
        file: "a.cfg",
        line: 3,
        params: { include: "printer.cfg" },
      },
    ]);
  });

  it("après un [include], une option sans nouvelle section est refusée (lecture par morceaux)", () => {
    const result = read({
      "printer.cfg": "[printer]\nkinematics: none\n[include x.cfg]\nmax_velocity: 300",
      "x.cfg": "[extruder]\nstep_pin: PA4",
    });
    expect(result.problems).toEqual([{ code: "config.no-section", file: "printer.cfg", line: 4 }]);
  });

  it("un fichier inclus deux fois est lu deux fois (pas une récursion)", () => {
    const result = read({
      "printer.cfg": "[include common.cfg]\n[printer]\nkinematics: none\n[include common.cfg]",
      "common.cfg": "[mcu]\nserial: /dev/ttyAMA0",
    });
    expect(result.problems).toEqual([]);
    expect(result.filesRead).toEqual(["printer.cfg", "common.cfg", "common.cfg"]);
  });

  it("en-têtes qui ne sont pas des inclusions : [include] seul, indenté, avec majuscule", () => {
    const result = read({
      "printer.cfg": "[include]\na: 1\n  [include ignored.cfg]\n[Include x.cfg]\nb: 2",
    });
    expect(result.sections.map((s) => s.name)).toEqual(["include", "Include x.cfg"]);
    // Plus indentée que l'option : la ligne prolonge la valeur de « a ».
    expect(value(result, "include", "a")?.value).toBe("1\n[include ignored.cfg]");
    expect(result.problems).toEqual([]);
  });
});

describe("readConfig : bloc SAVE_CONFIG", () => {
  it("l'option définie dans un fichier inclus l'emporte ; SAVE_CONFIG échouera", () => {
    const result = read({
      "printer.cfg": [
        "[include probe.cfg]",
        "[bed_mesh]",
        "speed: 100",
        "",
        ...HEADER,
        "#*# [probe]",
        "#*# z_offset = 1.915",
        "#*#",
        "#*# [bed_mesh]",
        "#*# speed = 120",
        "#*# horizontal_move_z = 5",
        "",
      ].join("\n"),
      "probe.cfg": "[probe]\npin: PB7\nz_offset: 1.0",
    });
    expect(value(result, "probe", "z_offset")).toMatchObject({
      value: "1.0",
      file: "probe.cfg",
      autosave: false,
    });
    expect(value(result, "bed_mesh", "speed")?.value).toBe("100");
    expect(value(result, "bed_mesh", "horizontal_move_z")).toMatchObject({
      value: "5",
      autosave: true,
      line: 13,
    });
    expect(result.problems).toEqual([
      {
        code: "config.autosave-overridden",
        file: "printer.cfg",
        line: 9,
        params: {
          section: "probe",
          option: "z_offset",
          definedIn: "probe.cfg",
          definedLine: 3,
          included: 1,
        },
      },
      {
        code: "config.autosave-overridden",
        file: "printer.cfg",
        line: 12,
        params: {
          section: "bed_mesh",
          option: "speed",
          definedIn: "printer.cfg",
          definedLine: 3,
          included: 0,
        },
      },
    ]);
  });

  it.each([
    [
      "ligne modifiée après l'en-tête",
      ["[probe]", "pin: PB7", "", ...HEADER, "#*# [probe]", "z_offset = 2", ""],
      "modified",
      8,
    ],
    [
      "lignes #*# sans en-tête",
      ["[probe]", "pin: PB7", "#*# [probe]", "#*# z_offset = 2", ""],
      "no-header",
      3,
    ],
    [
      "ligne #*# avant l'en-tête",
      ["[probe]", "pin: PB7", "#*# z_offset = 3", "", ...HEADER, "#*# [probe]"],
      "outside-block",
      3,
    ],
  ])("bloc ignoré par Klipper : %s", (_label, lines, reason, line) => {
    const result = read({ "printer.cfg": lines.join("\n") });
    expect(result.problems).toEqual([
      { code: "config.autosave-corrupted", file: "printer.cfg", line, params: { reason } },
    ]);
    // Aucune option ne vient du bloc (les lignes #*# ne sont plus que des commentaires).
    const options = result.sections.flatMap((s) => [...s.options.values()]);
    expect(options.filter((o) => o.autosave)).toEqual([]);
  });

  it("signale un bloc SAVE_CONFIG dans un fichier inclus (jamais lu)", () => {
    const result = read({
      "printer.cfg": "[printer]\nkinematics: none\n[include old.cfg]",
      "old.cfg": ["[probe]", "pin: PB7", "", ...HEADER, "#*# [probe]", "#*# z_offset = 2", ""].join(
        "\n",
      ),
    });
    expect(result.problems).toEqual([
      { code: "config.autosave-in-include", file: "old.cfg", line: 1 },
    ]);
    expect(value(result, "probe", "z_offset")).toBeUndefined();
  });

  it("parseConfig (outil Bed mesh) lit un extrait collé commençant par #*#", () => {
    const sections = parseConfig("#*# [bed_mesh default]\n#*# version = 1\n#*# x_count = 5");
    expect(sections.map((s) => s.name)).toEqual(["bed_mesh default"]);
    expect(sections[0]?.options.get("x_count")).toMatchObject({
      value: "5",
      autosave: true,
      line: 3,
    });
  });
});

describe("readConfig : lecture fidèle à Python", () => {
  it("un BOM en tête de fichier est refusé par Klipper (aucun en-tête de section)", () => {
    const result = read({ "printer.cfg": "﻿[printer]\nkinematics: none\n" });
    expect(result.problems[0]).toEqual({ code: "config.no-section", file: "printer.cfg", line: 1 });
  });

  it("CRLF et CR seul valent LF (fichier ouvert en mode texte)", () => {
    const result = read({
      "printer.cfg": "[printer]\rkinematics: none\r\n[extruder]\nstep_pin: PA4",
    });
    expect(value(result, "printer", "kinematics")).toMatchObject({ value: "none", line: 2 });
    expect(value(result, "extruder", "step_pin")?.line).toBe(4);
  });

  it("ligne sans délimiteur : erreur, et les lignes plus indentées prolongent l'option précédente", () => {
    const result = read({
      "printer.cfg": "[printer]\nkinematics: none\nligne sans delimiteur\n  suite\nmax_accel: 1000",
    });
    expect(result.problems).toEqual([{ code: "config.parse-error", file: "printer.cfg", line: 3 }]);
    expect(value(result, "printer", "kinematics")?.value).toBe("none\nsuite");
  });

  it("garde les lignes vides internes d'une valeur, pas les commentaires ; section sensible à la casse", () => {
    const result = read({
      "printer.cfg":
        "[gcode_macro A]\ngcode:\n  G28\n\n  ; note\n\tG1 Z5\n\n[Printer]\nmax_accel: 1",
    });
    expect(value(result, "gcode_macro A", "gcode")?.value).toBe("\nG28\n\nG1 Z5");
    expect(result.sections.map((s) => s.name)).toEqual(["gcode_macro A", "Printer"]);
  });
});

describe("chemins", () => {
  it("normalise, joint et découpe comme os.path", () => {
    expect(normalizePath("config\\sub/./x.cfg")).toBe("config/sub/x.cfg");
    expect(normalizePath("sub/../common.cfg")).toBe("common.cfg");
    expect(normalizePath("../hors.cfg")).toBe("../hors.cfg");
    expect(joinPath("config", "/abs/x.cfg")).toBe("/abs/x.cfg");
    expect(joinPath("", "x.cfg")).toBe("x.cfg");
    expect(dirname("config/printer.cfg")).toBe("config");
    expect(dirname("printer.cfg")).toBe("");
  });

  it.each([
    ["macros/*.cfg", "macros/a.cfg", true],
    ["macros/*.cfg", "macros/sub/a.cfg", false],
    ["macros/*.cfg", "macros/.cache.cfg", false],
    ["macros/.*.cfg", "macros/.cache.cfg", true],
    ["*/printer.cfg", "config/printer.cfg", true],
    ["hw/stepper_[xy].cfg", "hw/stepper_x.cfg", true],
    ["hw/stepper_[!xy].cfg", "hw/stepper_z.cfg", true],
    ["hw/stepper_?.cfg", "hw/stepper_z1.cfg", false],
    ["Macros/*.cfg", "macros/a.cfg", false],
  ])("%s trouve %s : %s", (pattern, path, expected) => {
    expect(matchesGlob(pattern, path)).toBe(expected);
  });
});
