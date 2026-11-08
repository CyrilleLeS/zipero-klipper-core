// SPDX-License-Identifier: GPL-3.0-only
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { readConfig } from "./ini";
import { issueSummary, readSummary, reformat, reformatPlan } from "./reformat.test-helper";
import { KLIPPER_SCHEMA } from "./schema";
import { validateConfig } from "./validate";

/**
 * Propriété (EP-19.03) : une configuration reformatée sans changer son sens pour Klipper (fins de
 * ligne, casse des noms d'options, `:` ou `=`, blancs, commentaires, lignes vides) donne la même
 * lecture et les mêmes diagnostics, aux numéros de ligne près. Configurations générées ici ; les
 * configurations réelles du corpus passent la même propriété dans `tooling/corpus-tests`.
 */

const SECTIONS = [
  "printer",
  "stepper_x",
  "stepper_y",
  "stepper_z",
  "extruder",
  "heater_bed",
  "probe",
  "bed_mesh",
  "safe_z_home",
  "fan",
  "mcu",
];
const OPTIONS = [
  "kinematics",
  "max_velocity",
  "max_accel",
  "step_pin",
  "dir_pin",
  "enable_pin",
  "rotation_distance",
  "microsteps",
  "endstop_pin",
  "position_max",
  "x_offset",
  "y_offset",
  "z_offset",
  "mesh_min",
  "mesh_max",
  "probe_count",
  "serial",
  "pin",
  "speed",
  "unknown_option",
];
const word = fc.stringMatching(/^[A-Za-z0-9_.!^/:-][A-Za-z0-9_.!^/:, -]{0,14}[A-Za-z0-9_.]$/);
const value = fc.oneof(
  word,
  fc.integer({ min: -500, max: 5000 }).map(String),
  fc.double({ min: -100, max: 100, noNaN: true }).map((n) => n.toFixed(3)),
  fc.constant(""),
);
const optionLine = fc.tuple(fc.constantFrom(...OPTIONS), value).map(([n, v]) => `${n}: ${v}`);
const plainSection = fc
  .tuple(fc.constantFrom(...SECTIONS), fc.array(optionLine, { maxLength: 6 }))
  .map(([name, options]) => [`[${name}]`, ...options]);
const macroSection = fc
  .tuple(
    fc.stringMatching(/^[A-Z][A-Z0-9_]{0,10}$/),
    fc.array(
      fc.constantFrom(
        "G28",
        "G1 Z10 F600",
        "M117 Prêt",
        "{% if x %}",
        "  M106 S255",
        "{% endif %}",
        "",
      ),
      {
        minLength: 1,
        maxLength: 6,
      },
    ),
  )
  .map(([name, body]) => [
    `[gcode_macro ${name}]`,
    "description: macro générée",
    "gcode:",
    ...body.map((line) => (line === "" ? "" : `  ${line}`)),
  ]);
const config = fc
  .array(fc.oneof(plainSection, macroSection), { minLength: 1, maxLength: 8 })
  .map((sections) => sections.flat().join("\n"));

const read = (text: string) =>
  readConfig({ files: new Map([["printer.cfg", text]]), main: "printer.cfg" });

describe("configuration reformatée : même lecture, mêmes diagnostics (EP-19.03)", () => {
  it("configurations générées", () => {
    fc.assert(
      fc.property(config, reformatPlan, (text, plan) => {
        const original = read(text);
        const reformatted = read(reformat(text, plan));
        expect(readSummary(reformatted)).toEqual(readSummary(original));
        expect(issueSummary(validateConfig(reformatted.sections, KLIPPER_SCHEMA))).toEqual(
          issueSummary(validateConfig(original.sections, KLIPPER_SCHEMA)),
        );
      }),
      { numRuns: 200 },
    );
  });

  it("contrôle inverse : un changement de sens pour Klipper est bien vu", () => {
    const text = "[printer]\nkinematics: cartesian\n[gcode_macro A]\ngcode:\n  G28\n  G1 Z5";
    // Nom de section en majuscules : une autre section pour Klipper (`repeat-and-case.cfg`).
    expect(readSummary(read(text.replace("[printer]", "[PRINTER]")))).not.toEqual(
      readSummary(read(text)),
    );
    // Ligne de G-code désindentée : elle quitte la valeur et devient une ligne illisible.
    expect(readSummary(read(text.replace("  G1 Z5", "G1 Z5")))).not.toEqual(
      readSummary(read(text)),
    );
  });

  it("le reformatage change bien le texte (la propriété n'est pas vide)", () => {
    const text = "[printer]\nkinematics: cartesian\nmax_velocity: 300\n[stepper_x]\nstep_pin: PB13";
    const plan = {
      crlf: true,
      lines: [
        {
          upper: true,
          delimiter: "=" as const,
          before: " ",
          after: "\t",
          trailing: "  ",
          comment: true,
          preamble: ["", "; note"],
        },
      ],
    };
    const changed = reformat(text, plan);
    expect(changed).toBe(
      [
        "",
        "; note",
        "[printer]  ",
        "KINEMATICS =\tcartesian   # ajouté",
        "MAX_VELOCITY =\t300   # ajouté",
        "",
        "; note",
        "[stepper_x]  ",
        "STEP_PIN =\tPB13   # ajouté",
      ].join("\r\n"),
    );
    expect(readSummary(read(changed))).toEqual(readSummary(read(text)));
  });
});
