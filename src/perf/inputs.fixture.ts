// SPDX-License-Identifier: GPL-3.0-only
/**
 * Entrées extrêmes déterministes pour le banc de mesure (EP-17.10). Tailles choisies au-delà des
 * cas réels : un maillage Beacon/Cartographer dense fait ~100×100, un printer.cfg ~2 000 lignes.
 */
import { printMesh, printProbedMatrix, respondInfo } from "../mesh/klipper-format.fixture";

const wave = (r: number, c: number) => Number((Math.sin(r / 7) * Math.cos(c / 5) * 0.2).toFixed(6));

export function denseMeshConsole(size: number): string {
  const grid = Array.from({ length: size }, (_, r) =>
    Array.from({ length: size }, (_, c) => wave(r, c)),
  );
  return `${printProbedMatrix(grid)}\n${printMesh({ mesh: grid })}`;
}

export function largePrinterCfg(sections: number): string {
  const lines: string[] = [];
  for (let s = 0; s < sections; s++) {
    lines.push(`[gcode_macro MACRO_${s}]`, "description: macro de test", "gcode:");
    for (let l = 0; l < 6; l++)
      lines.push(`  {% if params.X|default(0)|int > ${l} %}`, "    G1 X10 F3000", "  {% endif %}");
    lines.push("");
  }
  lines.push("#*# <---------------------- SAVE_CONFIG ---------------------->");
  lines.push("#*# DO NOT EDIT THIS BLOCK OR BELOW. The contents are auto-generated.");
  return lines.join("\n");
}

export function manyProbeSamples(count: number): string {
  return Array.from({ length: count }, (_, i) =>
    respondInfo(`probe at 117.500,117.500 is z=${(1.9 + (i % 5) * 0.0025).toFixed(6)}`),
  ).join("\n");
}
