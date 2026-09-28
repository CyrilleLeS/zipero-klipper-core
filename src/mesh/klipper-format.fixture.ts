// SPDX-License-Identifier: GPL-3.0-only
/**
 * Reproduction, pour les tests, du formatage de Klipper 0.13 (klippy/extras/bed_mesh.py et
 * klippy/gcode.py). Permet de générer des sorties console fidèles pour n'importe quelle grille.
 */

/** Équivalent de `"%f" % value` en Python (6 décimales). */
export const pyF = (value: number) => value.toFixed(6);

/** `gcode.respond_info` : lignes nettoyées puis préfixées par « // ». */
export const respondInfo = (msg: string) =>
  `// ${msg
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .join("\n// ")}`;

/** `ZMesh.print_probed_matrix` (grille avant → arrière). */
export function printProbedMatrix(matrix: readonly (readonly number[])[]): string {
  let msg = "Mesh Leveling Probed Z positions:\n";
  for (const line of matrix) msg += `${line.map((x) => ` ${pyF(x)}`).join("")}\n`;
  return respondInfo(msg);
}

/** `ZMesh.print_mesh` via `respond_raw` (grille interpolée avant → arrière, imprimée à l'envers). */
export function printMesh(options: {
  readonly mesh: readonly (readonly number[])[];
  readonly searchHeight?: number;
  readonly algorithm?: string;
}): string {
  const { mesh } = options;
  const flat = mesh.flat();
  const average = Math.round((flat.reduce((a, b) => a + b, 0) / flat.length) * 100) / 100;
  let msg = `Mesh X,Y: ${mesh[0]?.length ?? 0},${mesh.length}\n`;
  if (options.searchHeight !== undefined)
    msg += `Search Height: ${Math.trunc(options.searchHeight)}\n`;
  msg += "Mesh Offsets: X=0.0000, Y=0.0000\n";
  msg += `Mesh Average: ${average.toFixed(2)}\n`;
  msg += `Mesh Range: min=${Math.min(...flat).toFixed(4)} max=${Math.max(...flat).toFixed(4)}\n`;
  msg += `Interpolation Algorithm: ${options.algorithm ?? "lagrange"}\n`;
  msg += "Measured points:\n";
  for (let y = mesh.length - 1; y >= 0; y--) {
    msg += `${(mesh[y] ?? []).map((z) => `  ${pyF(z)}`).join("")}\n`;
  }
  return msg;
}

/** Interpolation bilinéaire simple, pour produire une grille « interpolée » cohérente. */
export function densify(matrix: readonly (readonly number[])[], pps: number): number[][] {
  const rows = matrix.length;
  const cols = matrix[0]?.length ?? 0;
  const outRows = (rows - 1) * (pps + 1) + 1;
  const outCols = (cols - 1) * (pps + 1) + 1;
  const at = (r: number, c: number) => matrix[r]?.[c] ?? 0;
  return Array.from({ length: outRows }, (_, i) =>
    Array.from({ length: outCols }, (_, j) => {
      const y = i / (pps + 1);
      const x = j / (pps + 1);
      const r0 = Math.min(Math.floor(y), rows - 2);
      const c0 = Math.min(Math.floor(x), cols - 2);
      const fy = y - r0;
      const fx = x - c0;
      const top = at(r0, c0) * (1 - fx) + at(r0, c0 + 1) * fx;
      const bottom = at(r0 + 1, c0) * (1 - fx) + at(r0 + 1, c0 + 1) * fx;
      return Number((top * (1 - fy) + bottom * fy).toFixed(6));
    }),
  );
}
