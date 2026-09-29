// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from "vitest";
import { loadSchema } from "../config/firmwares";
import { readConfig } from "../config/ini";
import { lintMacros, macroTemplates, templateOptions, templateSource } from "./templates";

const read = (text: string) =>
  readConfig({ files: new Map([["printer.cfg", text]]), main: "printer.cfg" }).sections;

describe("modèles d'une configuration (EP-06.07)", () => {
  it("options compilées d'après le schéma du firmware, et celles lues dynamiquement", async () => {
    const klipper = await loadSchema("klipper");
    const kalico = await loadSchema("kalico");
    expect([...templateOptions(klipper, "klipper", "gcode_macro START")]).toEqual(["gcode"]);
    expect(templateOptions(klipper, "klipper", "filament_switch_sensor f")).toEqual(
      new Set(["insert_gcode", "runout_gcode"]),
    );
    expect(templateOptions(klipper, "klipper", "display_template t")).toEqual(new Set(["text"]));
    expect(templateOptions(klipper, "klipper", "menu __main __x").has("title")).toBe(false);
    expect(templateOptions(kalico, "kalico", "menu __main __x").has("title")).toBe(true);
    expect(templateOptions(kalico, "kalico", "dockable_probe").has("attach_gcode")).toBe(false);
    expect(templateOptions(kalico, "kalico", "dockable_probe").has("pre_attach_gcode")).toBe(true);
    expect(templateOptions(klipper, "klipper", "printer").size).toBe(0);
  });

  it("Kalico : blancs retirés, scripts Python ignorés", () => {
    expect(templateSource("klipper", "\n  G28")).toEqual({ source: "\n  G28", offset: 0 });
    expect(templateSource("kalico", "\n\nG28\n")).toEqual({ source: "G28", offset: 2 });
    expect(templateSource("kalico", "\n!emit('G28')")).toBeUndefined();
    expect(templateSource("kalico", "!!include macros/start.py")).toBeUndefined();
  });

  it("erreur ramenée à la ligne du fichier, malgré les commentaires dans la macro", async () => {
    const sections = read(
      [
        "[printer]",
        "kinematics: none",
        "[gcode_macro START]",
        "description: pas un modèle { ",
        "gcode:",
        "  # commentaire",
        "  G28",
        "",
        "  ; autre commentaire",
        "  {% if x %}",
        "  G1 Z5",
      ].join("\n"),
    );
    const schema = await loadSchema("klipper");
    expect(macroTemplates(sections, schema, "klipper").map((t) => t.section)).toEqual([
      "gcode_macro START",
    ]);
    expect(lintMacros(sections, schema, "klipper")).toMatchObject([
      {
        code: "jinja.unclosed-block",
        section: "gcode_macro START",
        option: "gcode",
        file: "printer.cfg",
        startup: true,
        // Ligne « # commentaire » : vide dans la valeur (Klipper retire tout après #).
        line: 5,
        fileLine: 10,
      },
    ]);
  });

  it("Kalico : ligne du fichier malgré les lignes vides retirées en tête", async () => {
    const sections = read(["[gcode_macro M]", "gcode:", "", "  G28", "  { x @ y }"].join("\n"));
    const kalico = await loadSchema("kalico");
    expect(lintMacros(sections, kalico, "kalico")).toMatchObject([
      { code: "jinja.unexpected-char", line: 2, fileLine: 5 },
    ]);
  });
});
