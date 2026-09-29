// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from "vitest";
import { readConfig } from "./ini";
import { KLIPPER_SCHEMA } from "./schema";
import { type ValidationIssue, validateConfig } from "./validate";
import { pyBoolean, pyFloat, pyInt, pyLists } from "./values";

const check = (text: string, options: { partial?: boolean } = {}) => {
  const { sections } = readConfig({ files: new Map([["printer.cfg", text]]), main: "printer.cfg" });
  return validateConfig(sections, KLIPPER_SCHEMA, options);
};
const summary = (issues: readonly ValidationIssue[]) =>
  issues.map(
    (i) =>
      `${i.severity} ${i.code} [${i.section}] ${i.params?.["option"] ?? i.params?.["section"] ?? ""}`,
  );

/** Configuration cartésienne minimale et valide. */
const VALID = [
  "[mcu]",
  "serial: /dev/ttyACM0",
  "[printer]",
  "kinematics: cartesian",
  "max_velocity: 300",
  "max_accel: 3000",
  ...["x", "y", "z"].flatMap((axis) => [
    `[stepper_${axis}]`,
    "step_pin: PA0",
    "dir_pin: PA1",
    "enable_pin: !PA2",
    "microsteps: 16",
    "rotation_distance: 40",
    "endstop_pin: PA3",
    "position_endstop: 0",
    "position_max: 200",
  ]),
  "[extruder]",
  "step_pin: PB0",
  "dir_pin: PB1",
  "enable_pin: !PB2",
  "microsteps: 16",
  "rotation_distance: 33.5",
  "nozzle_diameter: 0.400",
  "filament_diameter: 1.750",
  "heater_pin: PB3",
  "sensor_type: EPCOS 100K B57560G104F",
  "sensor_pin: PC0",
  "control: pid",
  "pid_Kp: 22.2",
  "pid_Ki: 1.08",
  "pid_Kd: 114",
  "min_temp: 0",
  "max_temp: 250",
];

describe("validateConfig (schéma généré depuis Klipper 214fdb2877)", () => {
  it("une configuration valide ne produit aucune alerte", () => {
    expect(summary(check(VALID.join("\n")))).toEqual([]);
  });

  it("valeurs : conversion à la Python, bornes, choix, nombre d'éléments", () => {
    const issues = check(
      [
        ...VALID.map((l) =>
          l === "max_velocity: 300" ? "max_velocity: 0" : l === "control: pid" ? "control: pdi" : l,
        ),
        "[bed_mesh]",
        "mesh_min: 10",
        "mesh_max: 190, 190",
        "probe_count: 5,5",
      ].join("\n"),
    );
    expect(summary(issues)).toEqual([
      "error config.out-of-range [printer] max_velocity",
      "error config.invalid-choice [extruder] control",
      "error config.wrong-count [bed_mesh] mesh_min",
    ]);
    expect(issues[0]?.params).toMatchObject({ bound: "above", limit: 0 });
    expect(issues[1]?.params?.["choices"]).toBe("pid, watermark");
  });

  it("un entier refuse « 16.0 » (int() de Python), un booléen refuse « oui »", () => {
    const text =
      VALID.join("\n").replace("microsteps: 16", "microsteps: 16.0") +
      "\n[safe_z_home]\nhome_xy_position: 100, 100\nmove_to_previous: oui";
    expect(summary(check(text))).toEqual([
      "error config.invalid-value [stepper_x] microsteps",
      "error config.invalid-value [safe_z_home] move_to_previous",
    ]);
  });

  it("options supprimées (avec remplaçant), dépréciées ; famille default_parameter_", () => {
    const text = [
      ...VALID,
      "[printer]",
      "max_accel_to_decel: 1500",
      "[gcode_macro START]",
      "default_parameter_temp: 200",
      "variable_speed: 50",
      "gcode:",
      "  G28",
    ].join("\n");
    const issues = check(text);
    expect(summary(issues)).toEqual([
      "error config.removed-option [printer] max_accel_to_decel",
      "error config.removed-option [gcode_macro START] default_parameter_temp",
    ]);
    expect(issues[0]?.params).toMatchObject({
      since: "2025-08-11",
      replacement: "minimum_cruise_ratio",
    });
  });

  it("option inconnue avec suggestion ; section mal orthographiée (erreur) ou inconnue (avertissement)", () => {
    const text = [
      ...VALID,
      "[printer]",
      "max_velocty: 300",
      "[heater_bedd]",
      "heater_pin: PA1",
      "[mon_module]",
      "a: 1",
    ].join("\n");
    const issues = check(text);
    expect(summary(issues)).toEqual([
      "warning config.unknown-option [printer] max_velocty",
      "error config.unknown-section [heater_bedd] heater_bedd",
      "warning config.unknown-section [mon_module] mon_module",
    ]);
    expect(issues[0]?.params?.["suggestion"]).toBe("max_velocity");
    expect(issues[1]?.params?.["suggestion"]).toBe("heater_bed");
  });

  it("forks et modules installés à part : signalés « hors Klipper », jamais en erreur", () => {
    const text = [
      ...VALID,
      "[shaketune]",
      "result_folder: ~/x",
      "[heater_bed]",
      "pid_version: 1",
    ].join("\n");
    expect(summary(check(text)).filter((l) => l.includes("not-in-klipper"))).toEqual([
      "info config.not-in-klipper [shaketune] shaketune",
      "info config.not-in-klipper [heater_bed] pid_version",
    ]);
  });

  it("options obligatoires absentes, sauf configuration partielle (fichier inclus absent)", () => {
    const text = VALID.join("\n").replace("step_pin: PA0\n", "");
    expect(summary(check(text))).toEqual(["error config.missing-option [stepper_x] step_pin"]);
    expect(check(text, { partial: true })).toEqual([]);
  });

  it("variantes : options selon la cinématique et le capteur (thermistance personnalisée)", () => {
    // Delta : arm_length est une option des moteurs ; en cartésien, elle serait inconnue.
    const cartesian = check([...VALID, "[stepper_x]", "arm_length: 215"].join("\n"));
    expect(summary(cartesian)).toEqual(["warning config.unknown-option [stepper_x] arm_length"]);
    // Capteur défini par une section [thermistor NOM] : ses options de capteur sont valides.
    const custom =
      VALID.join("\n").replace("sensor_type: EPCOS 100K B57560G104F", "sensor_type: ma_sonde") +
      "\n[thermistor ma_sonde]\ntemperature1: 25\nresistance1: 100000\nbeta: 3950";
    expect(summary(check(custom))).toEqual([]);
    // Capteur inconnu : la section devient indécidable, aucune fausse option inconnue.
    const unknownSensor = VALID.join("\n").replace(
      "sensor_type: EPCOS 100K B57560G104F",
      "sensor_type: inconnu",
    );
    expect(summary(check(unknownSensor))).toEqual([]);
  });
});

describe("valeurs converties comme Python", () => {
  it.each([
    ["16", 16],
    [" +16 ", 16],
    ["1_000", 1000],
    ["16.0", undefined],
    ["0x10", undefined],
    ["", undefined],
  ])("int(%j) → %j", (text, expected) => {
    expect(pyInt(text)).toBe(expected);
  });

  it.each([
    ["0.4", 0.4],
    [".5", 0.5],
    ["1.", 1],
    ["1e3", 1000],
    ["-inf", Number.NEGATIVE_INFINITY],
    ["1_0.5", 10.5],
    [".", undefined],
    ["1,5", undefined],
  ])("float(%j) → %j", (text, expected) => {
    expect(pyFloat(text)).toBe(expected);
  });

  it("nan, booléens de configparser, listes et nombre d'éléments", () => {
    expect(pyFloat("NaN")).toBeNaN();
    expect(["1", "yes", "True", "on"].map(pyBoolean)).toEqual([true, true, true, true]);
    expect(["0", "No", "false", "OFF"].map(pyBoolean)).toEqual([false, false, false, false]);
    expect(pyBoolean("oui")).toBeUndefined();
    expect(pyLists("10, 20", [","], "float", 2)).toEqual({ ok: true, values: [10, 20] });
    expect(pyLists("10/128", ["/"], "int", 2)).toEqual({ ok: true, values: [10, 128] });
    expect(pyLists("10", [","], "float", 2)).toEqual({ ok: false, reason: "count", count: 2 });
    expect(pyLists("a, b", [","], "int")).toEqual({ ok: false, reason: "parse" });
    expect(pyLists("  ", [","], "string")).toEqual({ ok: true, values: [] });
    expect(pyLists("1:2, 3:4", [":", ","], "string")).toEqual({
      ok: true,
      values: [
        ["1", "2"],
        ["3", "4"],
      ],
    });
  });
});
