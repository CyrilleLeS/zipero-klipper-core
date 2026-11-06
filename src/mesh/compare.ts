// SPDX-License-Identifier: GPL-3.0-only

import { failure, type Issue, type ParseResult, success } from "../result";
import type { MeshGeometry, MeshGrid } from "./types";

/**
 * Comparaison de deux maillages (EP-05.12) : avant/après un réglage, à froid/à chaud. La
 * différence B − A n'a de sens que point à point : même nombre de rangées et de colonnes et,
 * quand les deux emprises sont connues, mêmes `mesh_min`/`mesh_max` (à `GEOMETRY_TOLERANCE` près,
 * choix de Zipero pour absorber l'écriture des nombres). Les hauteurs d'un maillage sont
 * relatives (Bed_Mesh.md) : un décalage commun à tous les points ne change pas la forme ; il est
 * donné à part (`offset`) et retiré de la différence centrée.
 */

export const MESH_COMPARE_CODES = [
  "compare.size-mismatch",
  "compare.geometry-mismatch",
  "compare.geometry-unknown",
] as const;
export type MeshCompareCode = (typeof MESH_COMPARE_CODES)[number];

/** Écart toléré entre deux emprises (mm). */
export const GEOMETRY_TOLERANCE = 0.01;

export interface ComparableMesh {
  readonly grid: MeshGrid;
  readonly geometry?: MeshGeometry | undefined;
}

export interface DifferencePoint {
  readonly row: number;
  readonly col: number;
  readonly value: number;
}

export interface MeshDifference {
  /** B − A, point par point (mm). */
  readonly raw: MeshGrid;
  /** B − A moins le décalage commun : ce qui a changé de forme. */
  readonly centered: MeshGrid;
  /** Décalage commun : moyenne de B − A (mm). */
  readonly offset: number;
  /** Plus grand changement de forme (valeur absolue de la différence centrée la plus forte). */
  readonly largest: DifferencePoint;
  /** Étendue (max − min) de A et de B, pour dire si le plateau s'est amélioré. */
  readonly rangeA: number;
  readonly rangeB: number;
}

const range = (grid: MeshGrid) => {
  const values = grid.values.flat();
  return Math.max(...values) - Math.min(...values);
};

function sameGeometry(a: MeshGeometry, b: MeshGeometry): boolean {
  return (["minX", "maxX", "minY", "maxY"] as const).every(
    (key) => Math.abs(a[key] - b[key]) <= GEOMETRY_TOLERANCE,
  );
}

export function compareMeshes(
  a: ComparableMesh,
  b: ComparableMesh,
): ParseResult<MeshDifference, MeshCompareCode> {
  if (a.grid.rows !== b.grid.rows || a.grid.cols !== b.grid.cols) {
    return failure({
      code: "compare.size-mismatch",
      params: { rowsA: a.grid.rows, colsA: a.grid.cols, rowsB: b.grid.rows, colsB: b.grid.cols },
    });
  }
  const warnings: Issue<MeshCompareCode>[] = [];
  if (a.geometry && b.geometry) {
    if (!sameGeometry(a.geometry, b.geometry))
      return failure({ code: "compare.geometry-mismatch" });
  } else if (a.geometry || b.geometry) {
    // Une seule emprise connue : points mis en correspondance par leur rang.
    warnings.push({ code: "compare.geometry-unknown" });
  }

  const raw = a.grid.values.map((row, r) =>
    row.map((z, c) => (b.grid.values[r]?.[c] as number) - z),
  );
  const all = raw.flat();
  const offset = all.reduce((sum, value) => sum + value, 0) / all.length;
  const centered = raw.map((row) => row.map((value) => value - offset));
  let largest: DifferencePoint = { row: 0, col: 0, value: centered[0]?.[0] as number };
  for (const [r, row] of centered.entries()) {
    for (const [c, value] of row.entries()) {
      if (Math.abs(value) > Math.abs(largest.value)) largest = { row: r, col: c, value };
    }
  }
  const grid = (values: number[][]): MeshGrid => ({ rows: a.grid.rows, cols: a.grid.cols, values });
  return success(
    {
      raw: grid(raw),
      centered: grid(centered),
      offset,
      largest,
      rangeA: range(a.grid),
      rangeB: range(b.grid),
    },
    warnings,
  );
}
