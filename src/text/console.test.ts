// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from "vitest";
import { cleanConsoleLine, consoleLines, parseNumberRow } from "./console";

describe("cleanConsoleLine", () => {
  it.each([
    ["// Mesh Leveling Probed Z positions:", "Mesh Leveling Probed Z positions:"],
    ["12:03:45 // 0.012500 -0.025000", "0.012500 -0.025000"],
    ["[12:03:45] // Mesh X,Y: 5,5", "Mesh X,Y: 5,5"],
    ["2026-09-28 12:03:45 Mesh Average: 0.02", "Mesh Average: 0.02"],
    ["Recv: // probe at 0.000,0.000 is z=2.506948", "probe at 0.000,0.000 is z=2.506948"],
    ["Send: PROBE_ACCURACY", "PROBE_ACCURACY"],
    ["echo: busy", "busy"],
    ["  0.012500  -0.025000  ", "0.012500  -0.025000"],
    ["12:03 BED_MESH_OUTPUT", "BED_MESH_OUTPUT"],
    // Formats relevés dans de vrais collages (tickets GitHub publics) :
    ["> Recv: // 0.002500 -0.002500 -0.065000", "0.002500 -0.002500 -0.065000"],
    ["> > // probe accuracy results: maximum 1", "probe accuracy results: maximum 1"],
    [">>> Recv: // Mesh X,Y: 7,7", "Mesh X,Y: 7,7"],
    ["[2020-04-16 09:01:24,376] DEBUG: // -9.709671 -9.709671", "-9.709671 -9.709671"],
    ["2020-04-16 09:01:24,376 - Recv: // Mesh X,Y: 5,5", "Mesh X,Y: 5,5"],
    [
      "0:00:13.539: // probe accuracy: at X:0.891 Y:1.134 Z:10.000",
      "probe accuracy: at X:0.891 Y:1.134 Z:10.000",
    ],
    [
      "1/12/2021, 12:54:08 PM | probe at 275.000,250.000 is z=0.347500",
      "probe at 275.000,250.000 is z=0.347500",
    ],
    [
      "`probe accuracy results: maximum 0.046484, minimum -0.431641`",
      "probe accuracy results: maximum 0.046484, minimum -0.431641",
    ],
  ])("« %s » → « %s »", (input, expected) => {
    expect(cleanConsoleLine(input)).toBe(expected);
  });
});

describe("consoleLines", () => {
  it("conserve les numéros de ligne d'origine", () => {
    expect(consoleLines("a\r\n// b")).toEqual([
      { line: 1, text: "a", content: "a" },
      { line: 2, text: "// b", content: "b" },
    ]);
  });
});

describe("parseNumberRow", () => {
  it("lit les nombres séparés par espaces, tabulations ou virgules", () => {
    expect(parseNumberRow("0.012500 -0.025000\t+1e-3")).toEqual([0.0125, -0.025, 0.001]);
    expect(parseNumberRow("-0.057500, -0.030000, .5")).toEqual([-0.0575, -0.03, 0.5]);
  });

  it("refuse une ligne vide ou contenant autre chose que des nombres", () => {
    expect(parseNumberRow("")).toBeNull();
    expect(parseNumberRow("Mesh X,Y: 5,5")).toBeNull();
    expect(parseNumberRow("0.1 abc")).toBeNull();
    expect(parseNumberRow("1.2.3")).toBeNull();
  });
});
