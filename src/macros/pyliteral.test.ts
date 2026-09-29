// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from "vitest";
import { checkMacroLiteral } from "./pyliteral";
import { LITERAL_CASES } from "./pyliteral.fixture";

describe("checkMacroLiteral : verdicts de Python (cas limites, EP-06.08)", () => {
  it.each(LITERAL_CASES.map((c) => [JSON.stringify(c.value), c] as const))("%s", (_label, c) => {
    expect(checkMacroLiteral(c.value) === undefined).toBe(c.accepted);
  });
});

describe("checkMacroLiteral : nature du problème", () => {
  it.each([
    ["auto", "unquoted"],
    ["PLA PETG", "unquoted"],
    ["true", "lowercase"],
    ["NULL", "lowercase"],
    ["{1, 2}", "notjson"],
    ["b'x'", "notjson"],
    ["1j", "notjson"],
    ["...", "notjson"],
    ["1 + 2", "invalid"],
    ["[1, 2", "invalid"],
  ] as const)("%j → %s", (value, problem) => {
    expect(checkMacroLiteral(value)).toBe(problem);
  });

  it("valeurs courantes des macros : acceptées", () => {
    for (const value of [
      "0",
      "-1.5",
      "'PLA'",
      "True",
      "None",
      "[1, 2]",
      "{'a': [1, {'b': None}]}",
    ]) {
      expect(checkMacroLiteral(value), value).toBeUndefined();
    }
  });
});
