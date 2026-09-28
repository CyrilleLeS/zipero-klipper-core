// SPDX-License-Identifier: GPL-3.0-only
import type { MeshGeometry, MeshGrid } from "./types";

/**
 * Métriques d'un maillage (EP-05.07). Convention : ligne 0 = avant (Y min), colonne 0 = gauche.
 *
 * Le plan de régression z = a + b·x + c·y est ajusté par moindres carrés. Sur une grille régulière
 * complète, les coordonnées centrées sont orthogonales : b et c se calculent indépendamment.
 * Les résidus (écart au plan) ne dépendent pas de l'échelle des axes : ils sont disponibles même
 * sans l'emprise du maillage. Les pentes en mm/100 mm, elles, exigent l'emprise.
 */

export interface GridPoint {
  readonly row: number;
  readonly col: number;
  readonly z: number;
}

export interface PlaneFit {
  /** Pente selon X en mm par 100 mm (positive : la droite est plus haute). Null sans emprise. */
  readonly slopeXPer100mm: number | null;
  /** Pente selon Y en mm par 100 mm (positive : l'arrière est plus haut). Null sans emprise. */
  readonly slopeYPer100mm: number | null;
  /** Dénivelé dû à l'inclinaison sur toute la largeur / profondeur du maillage (mm). */
  readonly riseX: number;
  readonly riseY: number;
  /** Amplitude des résidus après retrait du plan : défaut de planéité hors inclinaison (mm). */
  readonly residualRange: number;
  readonly residualStdDev: number;
}

export interface MeshMetrics {
  readonly count: number;
  readonly min: GridPoint;
  readonly max: GridPoint;
  /** Amplitude max − min (mm). */
  readonly range: number;
  readonly mean: number;
  /** Écart-type de population (mm). */
  readonly stdDev: number;
  readonly plane: PlaneFit;
}

export function computeMeshMetrics(grid: MeshGrid, geometry?: MeshGeometry): MeshMetrics {
  const { rows, cols, values } = grid;
  const points: GridPoint[] = values.flatMap((line, row) =>
    line.map((z, col) => ({ row, col, z })),
  );
  const count = points.length;

  // Premier point atteignant l'extremum (ordre avant → arrière, gauche → droite).
  const min = points.reduce((a, b) => (b.z < a.z ? b : a));
  const max = points.reduce((a, b) => (b.z > a.z ? b : a));
  const mean = points.reduce((sum, p) => sum + p.z, 0) / count;

  // Indices centrés (unités de pas de grille) : orthogonaux sur une grille complète.
  const cx = (cols - 1) / 2;
  const cy = (rows - 1) / 2;
  let sxz = 0;
  let syz = 0;
  let sxx = 0;
  let syy = 0;
  let variance = 0;
  for (const { row, col, z } of points) {
    const dx = col - cx;
    const dy = row - cy;
    sxz += dx * (z - mean);
    syz += dy * (z - mean);
    sxx += dx * dx;
    syy += dy * dy;
    variance += (z - mean) ** 2;
  }
  // Pentes par pas de grille (0 si un seul point sur l'axe).
  const perStepX = sxx === 0 ? 0 : sxz / sxx;
  const perStepY = syy === 0 ? 0 : syz / syy;

  const residuals = points.map(
    ({ row, col, z }) => z - (mean + perStepX * (col - cx) + perStepY * (row - cy)),
  );
  const residualMin = Math.min(...residuals);
  const residualMax = Math.max(...residuals);
  const residualSquares = residuals.reduce((sum, r) => sum + r ** 2, 0);

  const stepX = geometry && cols > 1 ? (geometry.maxX - geometry.minX) / (cols - 1) : null;
  const stepY = geometry && rows > 1 ? (geometry.maxY - geometry.minY) / (rows - 1) : null;
  const per100 = (perStep: number, step: number | null) =>
    step === null || step === 0 ? null : (perStep / step) * 100;

  return {
    count,
    min,
    max,
    range: max.z - min.z,
    mean,
    stdDev: Math.sqrt(variance / count),
    plane: {
      slopeXPer100mm: per100(perStepX, stepX),
      slopeYPer100mm: per100(perStepY, stepY),
      riseX: perStepX * (cols - 1),
      riseY: perStepY * (rows - 1),
      residualRange: residualMax - residualMin,
      residualStdDev: Math.sqrt(residualSquares / count),
    },
  };
}
