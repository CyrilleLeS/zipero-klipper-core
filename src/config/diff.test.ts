// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from "vitest";
import { REFERENCE_PRINTERS } from "../printers/reference";
import { COMPARABLE_PRINTERS, loadReferenceConfig } from "../printers/reference-config";
import { diffConfigs, normalizeValue, sameValue } from "./diff";
import { parseConfig, readConfig } from "./ini";

const BEFORE = [
  "[printer]",
  "kinematics: cartesian",
  "max_velocity: 300",
  "max_accel: 3000",
  "",
  "[extruder]",
  "rotation_distance: 22.6789511",
  "pressure_advance: 0.05",
  "",
  "[heater_bed]",
  "max_power: 1",
  "",
].join("\n");

const AFTER = [
  "[printer]",
  "kinematics:   cartesian",
  "max_velocity: 300.0",
  "max_accel: 5000",
  "",
  "[extruder]",
  "rotation_distance: 22.6789511",
  "",
  "[heater_bed]",
  "max_power: 1",
  "",
  "[bed_mesh]",
  "mesh_min: 10, 10",
  "",
].join("\n");

describe("comparaison de deux configurations (EP-06.11)", () => {
  it("options changées, retirées, sections ajoutées ; écritures équivalentes ignorées", () => {
    const diff = diffConfigs(parseConfig(BEFORE), parseConfig(AFTER));
    expect(diff.sections).toEqual([
      {
        name: "printer",
        status: "changed",
        options: [
          expect.objectContaining({
            name: "max_accel",
            status: "changed",
            before: "3000",
            after: "5000",
            line: 4,
          }),
        ],
      },
      {
        name: "extruder",
        status: "changed",
        options: [
          expect.objectContaining({ name: "pressure_advance", status: "removed", before: "0.05" }),
        ],
      },
      {
        name: "bed_mesh",
        status: "added",
        options: [expect.objectContaining({ name: "mesh_min", status: "added", after: "10, 10" })],
      },
    ]);
    expect(diff.counts).toEqual({
      sectionsAdded: 1,
      sectionsRemoved: 0,
      optionsChanged: 1,
      optionsAdded: 0,
      optionsRemoved: 1,
    });
    // Sens inverse : la section disparaît.
    expect(diffConfigs(parseConfig(AFTER), parseConfig(BEFORE)).counts.sectionsRemoved).toBe(1);
  });

  it("égalité : blancs normalisés, nombres égaux ; valeurs sur plusieurs lignes", () => {
    expect(normalizeValue("  G28\n\n    BED_MESH_CALIBRATE   ADAPTIVE=1 ")).toBe(
      "G28\nBED_MESH_CALIBRATE ADAPTIVE=1",
    );
    expect(sameValue("0.110", "0.11")).toBe(true);
    expect(sameValue("16", "016")).toBe(true);
    expect(sameValue("PA1", "PA2")).toBe(false);
    expect(sameValue("1, 2", "1,2")).toBe(false);
    expect(sameValue("G28\nG1 Z5", "G28\nG1 Z10")).toBe(false);
  });

  it("bloc SAVE_CONFIG : valeur appliquée par Klipper, marquée", () => {
    // Option seulement dans le bloc : Klipper l'applique. (Présente aussi dans le fichier, c'est
    // la valeur du fichier qui l'emporte : `_strip_duplicates`, reproduit par `readConfig`.)
    const withAutosave = `${BEFORE.replace("pressure_advance: 0.05\n", "")}\n#*# <---------------------- SAVE_CONFIG ---------------------->\n#*# DO NOT EDIT THIS BLOCK OR BELOW. The contents are auto-generated.\n#*#\n#*# [extruder]\n#*# pressure_advance = 0.042\n`;
    const read = readConfig({
      files: new Map([["printer.cfg", withAutosave]]),
      main: "printer.cfg",
    });
    const diff = diffConfigs(parseConfig(BEFORE), read.sections);
    expect(diff.sections).toEqual([
      {
        name: "extruder",
        status: "changed",
        options: [
          expect.objectContaining({
            name: "pressure_advance",
            before: "0.05",
            after: "0.042",
            autosave: true,
          }),
        ],
      },
    ]);
  });
});

describe("configurations d'origine publiées (EP-06.11)", () => {
  it("toutes celles sous GPL-3.0, pas le Qidi (AGPL-3.0)", async () => {
    expect(COMPARABLE_PRINTERS.length).toBe(REFERENCE_PRINTERS.length - 1);
    expect(COMPARABLE_PRINTERS.some((p) => p.id === "qidi-plus4")).toBe(false);
    expect(await loadReferenceConfig("qidi-plus4")).toBeUndefined();
    expect(await loadReferenceConfig("inconnue")).toBeUndefined();
    const ender = await loadReferenceConfig("creality-ender3-v2-2020");
    expect(ender).toContain("[stepper_x]");
    // Identique à la configuration de Klipper : comparée à elle-même, rien ne diffère.
    const sections = parseConfig(ender ?? "");
    expect(diffConfigs(sections, sections).sections).toEqual([]);
  });
});
