// SPDX-License-Identifier: GPL-3.0-only

/**
 * Grille de valeurs Z (mm). Convention unique dans tout le cœur :
 * `values[row][col]`, la ligne 0 est à l'AVANT du plateau (Y minimal), la colonne 0 à GAUCHE
 * (X minimal) — c'est l'ordre de `probed_matrix` dans Klipper.
 */
export interface MeshGrid {
  readonly rows: number;
  readonly cols: number;
  readonly values: readonly (readonly number[])[];
}

/** Emprise du maillage en mm (`mesh_min` / `mesh_max` effectifs). */
export interface MeshGeometry {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

/** Paramètres d'un profil sauvegardé (`#*# [bed_mesh <nom>]`). */
export interface MeshProfileParams extends MeshGeometry {
  readonly xCount: number;
  readonly yCount: number;
  readonly xPps: number;
  readonly yPps: number;
  readonly algorithm: string;
  readonly tension: number;
}

/** Construit une grille après vérification de sa forme (rectangulaire, au moins 1×1). */
export function toGrid(values: readonly (readonly number[])[]): MeshGrid | null {
  const cols = values[0]?.length ?? 0;
  if (values.length === 0 || cols === 0 || values.some((row) => row.length !== cols)) return null;
  return { rows: values.length, cols, values };
}
