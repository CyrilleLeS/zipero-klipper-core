// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from "vitest";
import { defined } from "./invariant";

describe("defined", () => {
  it("renvoie la valeur présente (y compris 0 et chaîne vide)", () => {
    expect(defined(0, "zéro")).toBe(0);
    expect(defined("", "vide")).toBe("");
  });

  it("échoue explicitement si la valeur manque", () => {
    expect(() => defined(undefined, "ligne")).toThrow("Invariant violé : ligne absent.");
  });
});
