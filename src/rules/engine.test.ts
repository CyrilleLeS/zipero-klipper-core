// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from "vitest";
import { parseConfig } from "../config/ini";
import {
  evaluateRules,
  type RuleBundle,
  type RuleCondition,
  type RuleDefinition,
  renderRuleText,
} from "./engine";

const CONFIG = parseConfig(
  [
    "[stepper_x]",
    "position_endstop: -5",
    "position_max: 235",
    "endstop_pin: ^PC0",
    "[stepper_z]",
    "endstop_pin: probe:z_virtual_endstop",
    "[safe_z_home]",
    "home_xy_position: 117.5, 250",
    "[mcu]",
    "serial: /dev/ttyUSB0",
  ].join("\n"),
);

const rule = (when: RuleCondition, extra: Partial<RuleDefinition> = {}): RuleBundle => ({
  format: 1,
  version: "test",
  rules: [
    {
      id: "test",
      severity: "warning",
      sections: extra.sections ?? "^stepper_x$",
      when,
      texts: { fr: { title: "t", detail: "d" } },
      source: "test",
      ...extra,
    },
  ],
});
const fires = (when: RuleCondition, extra: Partial<RuleDefinition> = {}) =>
  evaluateRules(CONFIG, rule(when, extra)).length > 0;

describe("evaluateRules", () => {
  it("comparaisons numériques (float() de Python), défaut d'une option absente", () => {
    expect(
      fires({ lt: [{ option: "position_endstop" }, { option: "position_min", default: 0 }] }),
    ).toBe(true);
    expect(fires({ gt: [{ option: "position_endstop" }, { option: "position_max" }] })).toBe(false);
    expect(fires({ ge: [{ option: "position_max" }, { number: 235 }] })).toBe(true);
    expect(fires({ le: [{ option: "position_max" }, { number: 234.9 }] })).toBe(false);
    // Valeur absente sans défaut : pas de conclusion.
    expect(fires({ lt: [{ option: "position_min" }, { number: 1 }] })).toBe(false);
  });

  it("existence, texte, expression régulière, négation, combinaisons", () => {
    expect(fires({ exists: { option: "endstop_pin" } })).toBe(true);
    expect(fires({ missing: { option: "position_min" } })).toBe(true);
    expect(fires({ eq: [{ option: "endstop_pin" }, { text: "^PC0" }] })).toBe(true);
    expect(fires({ ne: [{ option: "endstop_pin" }, { text: "^PC0" }] })).toBe(false);
    expect(fires({ matches: [{ option: "endstop_pin" }, "^probe:"] })).toBe(false);
    expect(fires({ not: { matches: [{ option: "endstop_pin" }, "^probe:"] } })).toBe(true);
    expect(
      fires({ all: [{ exists: { option: "position_max" } }, { missing: { option: "absent" } }] }),
    ).toBe(true);
    expect(
      fires({ any: [{ exists: { option: "absent" } }, { sectionExists: "^safe_z_home$" }] }),
    ).toBe(true);
    expect(fires({ matches: [{ option: "absent" }, ".*"] })).toBe(false);
  });

  it("autre section et élément de liste ; position du diagnostic et paramètres", () => {
    const bundle = rule(
      {
        gt: [
          { option: "home_xy_position", index: 1 },
          { section: "stepper_x", option: "position_max" },
        ],
      },
      {
        sections: "^safe_z_home$",
        at: "home_xy_position",
        params: { y: { option: "home_xy_position", index: 1 }, limit: { number: 235 } },
      },
    );
    expect(evaluateRules(CONFIG, bundle)).toEqual([
      {
        id: "test",
        severity: "warning",
        file: "printer.cfg",
        line: 8,
        section: "safe_z_home",
        params: { section: "safe_z_home", y: "250", limit: 235 },
      },
    ]);
  });

  it("règle fondée sur une absence : sautée sur une configuration partielle", () => {
    const bundle = rule({ missing: { option: "position_min" } }, { complete: true });
    expect(evaluateRules(CONFIG, bundle)).toHaveLength(1);
    expect(evaluateRules(CONFIG, bundle, { partial: true })).toEqual([]);
  });

  it("format de règles inconnu : ignoré (client plus ancien que les règles)", () => {
    expect(evaluateRules(CONFIG, { ...rule({ sectionExists: ".*" }), format: 99 })).toEqual([]);
  });

  it("condition inconnue : erreur explicite (jamais ignorée en silence)", () => {
    expect(() => fires({ between: [] } as unknown as RuleCondition)).toThrow(/Condition inconnue/);
  });
});

describe("renderRuleText", () => {
  it("remplace les paramètres ; nombres de la règle au format français, valeurs lues telles quelles", () => {
    expect(
      renderRuleText("{y} dépasse {limit} mm ({absent})", { y: "250", limit: 1234.5 }, "fr"),
    ).toBe("250 dépasse 1 234,5 mm ({absent})");
  });
});
