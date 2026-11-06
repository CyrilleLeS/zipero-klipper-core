// SPDX-License-Identifier: GPL-3.0-only

import type { MeshGrid } from "./types";

/**
 * Points aberrants d'un maillage (EP-05.09) : mesures isolées qui ne suivent pas leurs voisines
 * (débris, aimant de plaque, déclenchement raté de la sonde). Méthode (choix de Zipero, pas de
 * Klipper) :
 * - écart local d'un point = sa hauteur moins celle que prédit le plan ajusté (moindres carrés)
 *   sur ses voisins immédiats (8 au plus) : une pente ou une courbure générale ne compte pas,
 *   même au bord de la grille ;
 * - le pire point est retenu s'il dépasse le seuil, puis tout est recalculé sans lui, jusqu'à ce
 *   qu'aucun point ne dépasse : un seul faux point n'entraîne pas ses voisins ;
 * - seuil = le plus grand de `OUTLIER_SCALE` × dispersion robuste des écarts (1,4826 × écart
 *   absolu médian) et du seuil de bruit (`noise`, réglable comme pour le diagnostic de
 *   dispersion) ;
 * - au-delà de `OUTLIER_MAX_SHARE` des points, ce ne sont plus des mesures isolées mais une
 *   dispersion (diagnostic « mesures dispersées ») : rien n'est signalé ici ;
 * - un point dont les voisins ne permettent pas d'estimer une pente sur les deux axes n'est pas
 *   jugé ;
 * - plateau rond : Klipper complète chaque rangée par des copies de sa première et de sa dernière
 *   valeur mesurée, autant de chaque côté (`bed_mesh.py`, « round bed, extrapolate probed values
 *   to create a square mesh », commit 214fdb2877). Ces cases ne sont pas des mesures : reconnues à
 *   ce motif symétrique, elles ne sont ni jugées ni utilisées comme voisines (une vraie rangée qui
 *   le reproduirait par hasard n'est simplement pas examinée à ses bouts).
 */

/** Grille minimale : moins de 4 × 4, trop peu de voisins pour juger un point. */
export const OUTLIER_MIN_COUNT = 4;
/** Multiple de la dispersion robuste au-delà duquel un écart local est aberrant. */
export const OUTLIER_SCALE = 5;
/** Part maximale de points aberrants pour parler de mesures isolées. */
export const OUTLIER_MAX_SHARE = 0.05;
/**
 * Nombre maximal, quelle que soit la taille de la grille : au-delà, ce ne sont plus des mesures
 * isolées ; borne aussi le calcul (une passe sur toute la grille par point retenu, EP-16.02).
 */
export const OUTLIER_MAX_COUNT = 20;

export interface MeshOutlier {
  /** Rangée (0 = avant) et colonne (0 = gauche), dans l'ordre de Klipper. */
  readonly row: number;
  readonly col: number;
  readonly z: number;
  /** Écart à la hauteur prédite par les voisins (mm) : positif = trop haut. */
  readonly deviation: number;
}

const NEIGHBOURS = [-1, 0, 1].flatMap((dy) =>
  [-1, 0, 1].flatMap((dx) => (dx === 0 && dy === 0 ? [] : [[dx, dy] as const])),
);

/** Hauteur prédite au centre par le plan z = a + b·dx + c·dy ajusté sur les voisins. */
function predict(points: readonly (readonly [number, number, number])[]): number | null {
  const n = points.length;
  if (n < 3) return null;
  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (const [x, y, z] of points) {
    sx += x;
    sy += y;
    sz += z;
  }
  const mx = sx / n;
  const my = sy / n;
  const mz = sz / n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  let sxz = 0;
  let syz = 0;
  for (const [x, y, z] of points) {
    const dx = x - mx;
    const dy = y - my;
    const dz = z - mz;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
    sxz += dx * dz;
    syz += dy * dz;
  }
  const det = sxx * syy - sxy * sxy;
  // Voisins alignés : pente indéterminable sur un axe, le point n'est pas jugé.
  if (Math.abs(det) < 1e-9) return null;
  const b = (sxz * syy - syz * sxy) / det;
  const c = (syz * sxx - sxz * sxy) / det;
  // Au centre (0, 0) : a = mz − b·mx − c·my.
  return mz - b * mx - c * my;
}

function median(values: readonly number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * Cases ajoutées par Klipper aux bouts des rangées d'un plateau rond : autant de copies de la
 * première valeur au début que de la dernière à la fin.
 */
export function roundBedPadding(grid: MeshGrid): Set<number> {
  const padded = new Set<number>();
  grid.values.forEach((row, r) => {
    let leading = 0;
    while (leading + 1 < row.length && row[leading + 1] === row[0]) leading++;
    let trailing = 0;
    while (trailing + 1 < row.length && row[row.length - 2 - trailing] === row.at(-1)) trailing++;
    if (leading === 0 || leading !== trailing) return;
    for (let k = 0; k < leading; k++) {
      padded.add(r * grid.cols + k);
      padded.add(r * grid.cols + row.length - 1 - k);
    }
    // Rangée entièrement identique (une seule mesure au centre) : toutes ses cases.
    if (leading >= row.length - 1)
      for (let k = 0; k < row.length; k++) padded.add(r * grid.cols + k);
  });
  return padded;
}

export function findMeshOutliers(grid: MeshGrid, noise: number): MeshOutlier[] {
  const { rows, cols, values } = grid;
  if (rows < OUTLIER_MIN_COUNT || cols < OUTLIER_MIN_COUNT) return [];
  const total = rows * cols;
  const maxCount = Math.min(OUTLIER_MAX_COUNT, Math.max(1, Math.floor(total * OUTLIER_MAX_SHARE)));
  const excluded = roundBedPadding(grid);
  const found: MeshOutlier[] = [];

  for (;;) {
    const deviations: { row: number; col: number; z: number; deviation: number }[] = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        if (excluded.has(row * cols + col)) continue;
        const neighbours = NEIGHBOURS.flatMap(([dx, dy]) => {
          const r = row + dy;
          const c = col + dx;
          if (r < 0 || r >= rows || c < 0 || c >= cols || excluded.has(r * cols + c)) return [];
          return [[dx, dy, values[r]?.[c] as number] as const];
        });
        const expected = predict(neighbours);
        if (expected === null) continue;
        const z = values[row]?.[col] as number;
        deviations.push({ row, col, z, deviation: z - expected });
      }
    }
    if (deviations.length === 0) break;
    const spread = 1.4826 * median(deviations.map((d) => Math.abs(d.deviation)));
    const threshold = Math.max(OUTLIER_SCALE * spread, noise);
    const worst = deviations.reduce((a, b) =>
      Math.abs(b.deviation) > Math.abs(a.deviation) ? b : a,
    );
    if (Math.abs(worst.deviation) <= threshold) break;
    found.push(worst);
    excluded.add(worst.row * cols + worst.col);
    // Trop de points : une dispersion générale, pas des mesures isolées.
    if (found.length > maxCount) return [];
  }
  return found.toSorted((a, b) => a.row - b.row || a.col - b.col);
}
