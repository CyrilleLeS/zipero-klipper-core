// SPDX-License-Identifier: GPL-3.0-only
import { defined } from "../invariant";
import type { MeshGrid } from "./types";

/**
 * Interpolation du maillage, portage fidèle de `ZMesh` (klippy/extras/bed_mesh.py, Klipper
 * commit 214fdb2877) : c'est la surface que Klipper utilise réellement pour compenser (EP-05.05).
 * - `mesh_pps` points ajoutés entre deux points mesurés, sur chaque axe ;
 * - Lagrange (polynôme passant par tous les points de la ligne) ou bicubique (spline cardinale
 *   avec `bicubic_tension`) ; X d'abord sur les lignes mesurées, puis Y sur toutes les colonnes ;
 * - choix effectif de l'algorithme comme `_verify_algorithm` : `direct` si pps = 0, bicubique
 *   ramené à Lagrange sous 4 points, combinaisons refusées par Klipper signalées.
 * Convention du cœur : ligne 0 = avant (Y min), colonne 0 = gauche (X min).
 */

export type MeshAlgorithm = "lagrange" | "bicubic" | "direct";

export interface InterpolationParams {
  readonly xPps: number;
  readonly yPps: number;
  readonly algorithm: string;
  readonly tension: number;
}

export type InterpolationCode =
  | "interpolate.unknown-algorithm"
  | "interpolate.lagrange-too-many"
  | "interpolate.bicubic-invalid";

export type Interpolation =
  | { readonly ok: true; readonly algorithm: MeshAlgorithm; readonly grid: MeshGrid }
  | { readonly ok: false; readonly code: InterpolationCode };

/** Réglages par défaut de Klipper : `mesh_pps: 2, 2`, `algorithm: lagrange`, tension 0,2. */
export const DEFAULT_INTERPOLATION: InterpolationParams = {
  xPps: 2,
  yPps: 2,
  algorithm: "lagrange",
  tension: 0.2,
};

/** Algorithme réellement appliqué par Klipper pour cette grille (`_verify_algorithm`). */
export function effectiveAlgorithm(
  cols: number,
  rows: number,
  params: InterpolationParams,
): MeshAlgorithm | InterpolationCode {
  const algorithm = params.algorithm.trim().toLowerCase();
  if (!["lagrange", "bicubic", "direct"].includes(algorithm))
    return "interpolate.unknown-algorithm";
  const maxCount = Math.max(cols, rows);
  const minCount = Math.min(cols, rows);
  if (Math.max(params.xPps, params.yPps) === 0) return "direct";
  if (algorithm === "lagrange" && maxCount > 6) return "interpolate.lagrange-too-many";
  if (algorithm === "bicubic" && minCount < 4) {
    return maxCount > 6 ? "interpolate.bicubic-invalid" : "lagrange";
  }
  return algorithm as MeshAlgorithm;
}

const isInterpolationCode = (
  value: MeshAlgorithm | InterpolationCode,
): value is InterpolationCode => value.startsWith("interpolate.");

export function interpolateMesh(grid: MeshGrid, params: InterpolationParams): Interpolation {
  const { cols, rows, values } = grid;
  const algorithm = effectiveAlgorithm(cols, rows, params);
  if (isInterpolationCode(algorithm)) return { ok: false, code: algorithm };
  if (algorithm === "direct") {
    return {
      ok: true,
      algorithm: "direct",
      grid: { cols, rows, values: values.map((line) => [...line]) },
    };
  }

  const xMult = params.xPps + 1;
  const yMult = params.yPps + 1;
  const xCount = (cols - 1) * params.xPps + cols;
  const yCount = (rows - 1) * params.yPps + rows;
  // Coordonnées normalisées : seules les proportions comptent pour Lagrange (le résultat ne
  // dépend pas de l'échelle), et la spline travaille en indices.
  const xAt = (index: number) => index / (xCount - 1);
  const yAt = (index: number) => index / (yCount - 1);
  const matrix: number[][] = Array.from({ length: yCount }, (_, j) =>
    Array.from({ length: xCount }, (_, i) =>
      i % xMult || j % yMult ? 0 : defined(values[j / yMult]?.[i / xMult], "point mesuré"),
    ),
  );
  const at = (j: number, i: number) => defined(matrix[j]?.[i], "case interpolée");
  const set = (j: number, i: number, value: number) => {
    defined(matrix[j], "ligne")[i] = value;
  };

  if (algorithm === "lagrange") {
    const xPts = Array.from({ length: cols }, (_, i) => xAt(i * xMult));
    const yPts = Array.from({ length: rows }, (_, j) => yAt(j * yMult));
    const lagrange = (points: readonly number[], c: number, sample: (k: number) => number) => {
      let total = 0;
      points.forEach((pi, i) => {
        let n = 1;
        let d = 1;
        points.forEach((pj, j) => {
          if (j === i) return;
          n *= c - pj;
          d *= pi - pj;
        });
        total += (sample(i) * n) / d;
      });
      return total;
    };
    for (let j = 0; j < yCount; j += yMult) {
      for (let i = 0; i < xCount; i++) {
        if (i % xMult === 0) continue;
        set(
          j,
          i,
          lagrange(xPts, xAt(i), (k) => at(j, k * xMult)),
        );
      }
    }
    for (let i = 0; i < xCount; i++) {
      for (let j = 0; j < yCount; j++) {
        if (j % yMult === 0) continue;
        set(
          j,
          i,
          lagrange(yPts, yAt(j), (k) => at(k * yMult, i)),
        );
      }
    }
  } else {
    const spline = (p0: number, p1: number, p2: number, p3: number, t: number) => {
      const t2 = t * t;
      const t3 = t2 * t;
      const m1 = params.tension * (p2 - p0);
      const m2 = params.tension * (p3 - p1);
      return (
        p1 * (2 * t3 - 3 * t2 + 1) +
        p2 * (-2 * t3 + 3 * t2) +
        m1 * (t3 - 2 * t2 + t) +
        m2 * (t3 - t2)
      );
    };
    /** Points de contrôle d'une position `k` sur un axe de `count` cases, pas `mult`. */
    const controls = (
      k: number,
      count: number,
      mult: number,
      sample: (index: number) => number,
    ) => {
      const last = count - 1 - mult;
      if (k < mult) return spline(sample(0), sample(0), sample(mult), sample(2 * mult), k / mult);
      if (k > last) {
        return spline(
          sample(last - mult),
          sample(last),
          sample(last + mult),
          sample(last + mult),
          (k - last) / mult,
        );
      }
      const i = Math.floor(k / mult) * mult;
      return spline(
        sample(i - mult),
        sample(i),
        sample(i + mult),
        sample(i + 2 * mult),
        (k - i) / mult,
      );
    };
    for (let j = 0; j < yCount; j += yMult) {
      for (let i = 0; i < xCount; i++) {
        if (i % xMult === 0) continue;
        set(
          j,
          i,
          controls(i, xCount, xMult, (k) => at(j, k)),
        );
      }
    }
    for (let i = 0; i < xCount; i++) {
      for (let j = 0; j < yCount; j++) {
        if (j % yMult === 0) continue;
        set(
          j,
          i,
          controls(j, yCount, yMult, (k) => at(k, i)),
        );
      }
    }
  }
  return { ok: true, algorithm, grid: { cols: xCount, rows: yCount, values: matrix } };
}
