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

/** G-code d'environ `megabytes` Mo : couches de 500 extrusions (EP-04, lecture). */
export function largeGcode(megabytes: number): Uint8Array {
  const layer: string[] = [];
  for (let k = 0; k < 500; k++)
    layer.push(`G1 X${(k % 200).toFixed(3)} Y${(k % 7).toFixed(3)} E0.01`);
  const body = layer.join("\n");
  const parts = ["M83"];
  let size = 0;
  for (let l = 1; size < megabytes * 1_000_000; l++) {
    parts.push(`G1 Z${(l * 0.2).toFixed(2)}`, body);
    size += body.length;
  }
  // ASCII seulement : le paquet autonome n'a pas TextEncoder (ni types Node ni DOM).
  return Uint8Array.from(parts.join("\n"), (c) => c.charCodeAt(0));
}
