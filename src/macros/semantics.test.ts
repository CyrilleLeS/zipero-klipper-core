// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from "vitest";
import { loadSchema } from "../config/firmwares";
import { readConfig } from "../config/ini";
import { checkMacros, isTraditionalGcode, klipperCommand } from "./semantics";

const BASE = ["[printer]", "kinematics: none", "max_velocity: 1", "max_accel: 1"];

async function check(
  lines: readonly string[],
  options: { partial?: boolean; firmware?: "klipper" | "kalico" } = {},
) {
  const text = [...BASE, ...lines].join("\n");
  const { sections } = readConfig({ files: new Map([["printer.cfg", text]]), main: "printer.cfg" });
  const firmware = options.firmware ?? "klipper";
  return checkMacros(sections, await loadSchema(firmware), firmware, {
    partial: options.partial ?? false,
  });
}

const codes = (issues: Awaited<ReturnType<typeof check>>) =>
  issues.map((i) => `${i.severity} ${i.code} ${i.line}`);

describe("règles de Klipper (gcode.py)", () => {
  it("commande traditionnelle : lettre suivie d'un nombre", () => {
    expect(isTraditionalGcode("G28")).toBe(true);
    expect(isTraditionalGcode("M106.1")).toBe(true);
    expect(isTraditionalGcode("M106_ORIG")).toBe(false);
    expect(isTraditionalGcode("PRINT_START")).toBe(false);
    expect(isTraditionalGcode("")).toBe(false);
  });

  it("découpage d'une ligne comme _process_commands", () => {
    expect(klipperCommand("  g1 x10 ; commentaire")).toMatchObject({
      command: "G1",
      params: { G: "1", X: "10" },
    });
    expect(klipperCommand("M106_ORIG S100")?.command).toBe("M106");
    expect(klipperCommand("PRINT_START2 A=1")?.command).toBe("PRINT_START2");
    expect(klipperCommand("N10 G28")?.command).toBe("G28");
    expect(klipperCommand("M117 5")?.command).toBe("M117 5");
    expect(klipperCommand("  ; rien")).toBeUndefined();
  });
});

describe("refus au démarrage", () => {
  it("nom de macro avec espace, nom invalide", async () => {
    const issues = await check([
      "[gcode_macro A B]",
      "gcode: G28",
      "[gcode_macro print-start]",
      "gcode: G28",
    ]);
    expect(codes(issues)).toEqual(["error macro.name-whitespace 5", "error macro.invalid-name 7"]);
  });

  it("commande déjà définie : par Klipper ou par une autre macro (même en minuscules)", async () => {
    const issues = await check([
      "[gcode_macro G28]",
      "gcode: G1 Z5",
      "[gcode_macro foo]",
      "gcode: G4",
      "[gcode_macro FOO]",
      "gcode: G4",
    ]);
    expect(codes(issues)).toEqual(["error macro.command-exists 5", "error macro.command-exists 9"]);
  });

  it("rename_existing : types différents, commande absente, cible prise ou invalide", async () => {
    const issues = await check([
      "[gcode_macro M106]",
      "rename_existing: M106_ORIG",
      "gcode: G4",
      "[gcode_macro NOPE]",
      "rename_existing: NOPE_BASE",
      "gcode: G4",
      "[gcode_macro G28]",
      "rename_existing: G1",
      "gcode: G4",
      "[gcode_macro G4]",
      "rename_existing: g4.1",
      "gcode: G4.1",
      "[gcode_macro SET_VELOCITY_LIMIT]",
      "rename_existing: base_limit",
      "gcode: G4",
    ]);
    expect(codes(issues)).toEqual([
      "error macro.rename-type 6",
      "error macro.rename-missing 9",
      "error macro.rename-taken 12",
      "error macro.rename-invalid-name 18",
      // « g4.1 » enregistrée en minuscules : Klipper cherche « G4.1 », introuvable.
      "warning macro.unknown-command 16",
    ]);
  });

  it("module installé à part : commande renommée peut-être fournie (avertissement)", async () => {
    const issues = await check([
      "[beacon]",
      "serial: /dev/x",
      "[gcode_macro BEACON_X]",
      "rename_existing: BEACON_X_BASE",
      "gcode: G4",
    ]);
    expect(codes(issues)).toEqual(["warning macro.rename-missing 8"]);
  });

  it("variable qui n'est pas un littéral Python", async () => {
    const issues = await check([
      "[gcode_macro M]",
      "variable_mode: auto",
      "variable_ok: 'auto'",
      "gcode: G4",
    ]);
    expect(issues).toMatchObject([
      {
        code: "macro.variable-literal",
        severity: "error",
        line: 6,
        params: { variable: "variable_mode", problem: "unquoted" },
      },
    ]);
  });
});

describe("erreurs à l'exécution", () => {
  it("paramètres : minuscules jamais reçus, sans valeur par défaut (information)", async () => {
    const issues = await check([
      "[gcode_macro M]",
      "gcode:",
      "  {% set a = params.temp|default(1) %}",
      "  {% set b = params.SPEED %}",
      "  {% set c = params.X|default(0) %}",
      "  {% if params.Y %}G4{% endif %}",
      "  {% if 'Z' in params %}{params.Z}{% endif %}",
      "  {params.get('W')}",
    ]);
    expect(issues.map((i) => [i.code, i.line, i.params?.["param"]])).toEqual([
      ["macro.param-case", 7, "temp"],
      ["macro.param-default", 8, "SPEED"],
    ]);
  });

  it("objets et variables d'autres macros ; gardes et valeur par défaut respectées", async () => {
    const issues = await check([
      "[gcode_macro CONF]",
      "variable_speed: 10",
      "gcode: G4",
      "[gcode_macro M]",
      "gcode:",
      "  {printer['gcode_macro CONF'].speed}",
      "  {printer['gcode_macro CONF'].Speed}",
      "  {printer['gcode_macro conf'].speed}",
      "  {printer['filament_switch_sensor s'].filament_detected}",
      "  {% set c = printer['gcode_macro MISSING']|default({}) %}",
      "  {% if 'x' in printer['gcode_macro CONF'] %}{printer['gcode_macro CONF'].x}{% endif %}",
    ]);
    expect(issues.map((i) => [i.code, i.line, i.params])).toEqual([
      ["macro.unknown-variable", 11, { variable: "Speed", macro: "CONF", suggestion: "speed" }],
      ["macro.unknown-object", 12, { object: "gcode_macro conf", suggestion: "gcode_macro CONF" }],
      ["macro.unknown-object", 13, { object: "filament_switch_sensor s", suggestion: "none" }],
    ]);
  });

  it("SET_GCODE_VARIABLE et UPDATE_DELAYED_GCODE", async () => {
    const issues = await check([
      "[delayed_gcode later]",
      "gcode: G4",
      "[gcode_macro CONF]",
      "variable_speed: 10",
      "gcode:",
      "  SET_GCODE_VARIABLE MACRO=CONF VARIABLE=speed VALUE=5",
      "  SET_GCODE_VARIABLE MACRO=conf VARIABLE=speed VALUE=5",
      "  SET_GCODE_VARIABLE MACRO=CONF VARIABLE=Speed VALUE=5",
      "  SET_GCODE_VARIABLE MACRO=CONF VARIABLE=speed VALUE=fast",
      "  SET_GCODE_VARIABLE MACRO=CONF VARIABLE=speed VALUE={1}",
      "  UPDATE_DELAYED_GCODE ID=later DURATION=1",
      "  UPDATE_DELAYED_GCODE ID=soon DURATION=1",
    ]);
    expect(issues.map((i) => [i.code, i.line])).toEqual([
      ["macro.set-variable-macro", 11],
      ["macro.set-variable-unknown", 12],
      ["macro.set-variable-value", 13],
      ["macro.delayed-gcode-unknown", 16],
    ]);
  });

  it("appel récursif, direct ou par une autre macro", async () => {
    const issues = await check([
      "[gcode_macro A]",
      "gcode: B",
      "[gcode_macro B]",
      "gcode:",
      "  {% if x %}A{% endif %}",
      "[gcode_macro C]",
      "gcode: C",
    ]);
    expect(issues.map((i) => [i.code, i.line, i.params])).toEqual([
      ["macro.recursive", 6, { macro: "A", callee: "B" }],
      ["macro.recursive", 9, { macro: "B", callee: "A" }],
      ["macro.recursive", 11, { macro: "C", callee: "C" }],
    ]);
  });

  it("commandes inconnues ; ignorées sans message ; ligne de configuration dans un script", async () => {
    const issues = await check([
      "[gcode_macro M]",
      "rename_existing: M_BASE",
      "description: pas une commande",
      "gcode:",
      "  G28",
      "  M_BASE",
      "  M104 S0",
      "  M107",
      "  M106 S0",
      "  G01 X1",
      "  {macro_name} X=1",
      "  pid_kp: 22.2",
      "[menu __main __x]",
      "type: command",
      "name: PAS UNE COMMANDE",
    ]);
    expect(issues.map((i) => [i.code, i.line, i.params])).toEqual([
      ["macro.rename-missing", 6, { command: "M" }],
      ["macro.unknown-command", 14, { command: "G01" }],
      ["macro.config-line", 16, { text: "pid_kp: 22.2" }],
    ]);
  });

  it("configuration incomplète : pas d'alerte fondée sur une absence", async () => {
    const issues = await check(
      ["[gcode_macro M]", "gcode:", "  INCONNUE", "  {printer['gcode_macro X'].y}"],
      { partial: true },
    );
    expect(issues).toEqual([]);
  });

  it("Kalico : mêmes contrôles, schéma et commandes de Kalico", async () => {
    const issues = await check(["[gcode_macro M]", "gcode: INCONNUE"], { firmware: "kalico" });
    expect(codes(issues)).toEqual(["warning macro.unknown-command 6"]);
  });
});
