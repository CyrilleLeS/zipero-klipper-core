// SPDX-License-Identifier: GPL-3.0-only
import { defined } from "../invariant";
import type { MeshGrid } from "./types";

/**
 * Classification de la forme d'un maillage (EP-05.08).
 *
 * Ajustement par moindres carrés de z = a + b·u + c·v + d·u² + e·u·v + f·v², où u et v sont les
 * coordonnées de la grille ramenées à [-1, 1] (u : gauche → droite, v : avant → arrière). Chaque
 * composante est mesurée par son AMPLITUDE sur le plateau (mm, crête à crête sur [-1, 1]²), ce
 * qui la rend indépendante de l'échelle des axes et comparable aux autres :
 * - inclinaison : b·u + c·v → 2(|b| + |c|) ;
 * - courbure : d·u² + f·v² → cuvette (d, f > 0 : centre bas), dôme (< 0), selle (signes opposés) ;
 * - torsion : e·u·v → 2|e| (deux coins opposés hauts, les deux autres bas).
 *
 * Classes : plat (amplitude mesurée ≤ tolérance), irrégulier (la surface quadratique explique
 * moins de la moitié de la variance : bosse ou creux local), sinon la composante dominante.
 * Convention Klipper : une valeur plus haute = plateau plus haut à cet endroit.
 */

export type MeshShape = "flat" | "tilted" | "bowl" | "dome" | "saddle" | "twisted" | "irregular";

export interface ShapeComponents {
  /** Amplitudes crête à crête sur le plateau (mm). */
  readonly tilt: number;
  readonly curvature: number;
  readonly twist: number;
  /** Amplitude de ce que la surface quadratique n'explique pas (défauts locaux, bruit). */
  readonly residual: number;
}

export interface ShapeClassification {
  readonly shape: MeshShape;
  /** Indice de confiance entre 0 et 1 (voir `classifyMeshShape`). */
  readonly confidence: number;
  /** Seconde forme notable (≥ la moitié de la dominante et ≥ la moitié de la tolérance). */
  readonly secondary?: Exclude<MeshShape, "flat" | "irregular">;
  /** Part de la variance expliquée par la surface quadratique (R², entre 0 et 1). */
  readonly explained: number;
  readonly components: ShapeComponents;
  /** Axe de la courbure : les deux, ou un seul (plateau cintré en gouttière). */
  readonly curvatureAxis: "both" | "x" | "y" | null;
  /** Diagonale haute de la torsion (coin avant gauche + arrière droit, ou l'inverse). */
  readonly highDiagonal: "frontLeft-backRight" | "frontRight-backLeft" | null;
}

export interface ShapeOptions {
  /** Amplitude en dessous de laquelle le plateau est dit plat (mm). */
  readonly flatTolerance?: number;
}

/** 0,1 mm : amplitude usuellement jugée excellente pour un plateau compensé par maillage. */
export const DEFAULT_FLAT_TOLERANCE = 0.1;
/** En dessous de ce R², la forme n'est pas quadratique : défaut local. */
const MIN_EXPLAINED = 0.5;
/** Courbure sur un seul axe si l'autre coefficient vaut moins de 25 % du premier. */
const SINGLE_AXIS_RATIO = 0.25;

type Basis = (u: number, v: number) => number;

/** Résout A·x = y (A carrée, copiée) par élimination de Gauss avec pivot partiel. */
function solve(matrix: number[][], rhs: number[]): number[] {
  const n = rhs.length;
  const a = matrix.map((row, i) => [...row, defined(rhs[i], "second membre")]);
  const at = (r: number, c: number) => defined(a[r]?.[c], "coefficient");
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++)
      if (Math.abs(at(r, col)) > Math.abs(at(pivot, col))) pivot = r;
    [a[col], a[pivot]] = [defined(a[pivot], "ligne"), defined(a[col], "ligne")];
    const p = at(col, col);
    for (let r = col + 1; r < n; r++) {
      const factor = at(r, col) / p;
      const row = defined(a[r], "ligne");
      for (let c = col; c <= n; c++) row[c] = at(r, c) - factor * at(col, c);
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let sum = at(r, n);
    for (let c = r + 1; c < n; c++) sum -= at(r, c) * defined(x[c], "inconnue");
    x[r] = sum / at(r, r);
  }
  return x;
}

export function classifyMeshShape(grid: MeshGrid, options: ShapeOptions = {}): ShapeClassification {
  const tolerance = options.flatTolerance ?? DEFAULT_FLAT_TOLERANCE;
  const { rows, cols, values } = grid;
  const cx = (cols - 1) / 2;
  const cy = (rows - 1) / 2;
  const points = values.flatMap((line, row) =>
    line.map((z, col) => ({
      u: cx === 0 ? 0 : (col - cx) / cx,
      v: cy === 0 ? 0 : (row - cy) / cy,
      z,
    })),
  );

  // Termes identifiables selon la taille de la grille (3 valeurs par axe pour une courbure).
  const terms: [keyof typeof coefficients, Basis][] = [["a", () => 1]];
  const coefficients = { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 };
  if (cols >= 2) terms.push(["b", (u) => u]);
  if (rows >= 2) terms.push(["c", (_, v) => v]);
  if (cols >= 3) terms.push(["d", (u) => u * u]);
  if (cols >= 2 && rows >= 2) terms.push(["e", (u, v) => u * v]);
  if (rows >= 3) terms.push(["f", (_, v) => v * v]);

  const normal = terms.map(() => new Array<number>(terms.length).fill(0));
  const rhs = new Array<number>(terms.length).fill(0);
  for (const { u, v, z } of points) {
    const basis = terms.map(([, fn]) => fn(u, v));
    basis.forEach((bi, i) => {
      rhs[i] = defined(rhs[i], "rhs") + bi * z;
      const row = defined(normal[i], "ligne");
      basis.forEach((bj, j) => {
        row[j] = defined(row[j], "coefficient") + bi * bj;
      });
    });
  }
  solve(normal, rhs).forEach((value, i) => {
    coefficients[defined(terms[i], "terme")[0]] = value;
  });
  const { a, b, c, d, e, f } = coefficients;

  const zs = points.map((p) => p.z);
  const mean = zs.reduce((sum, z) => sum + z, 0) / zs.length;
  let residualMin = Number.POSITIVE_INFINITY;
  let residualMax = Number.NEGATIVE_INFINITY;
  let ssRes = 0;
  let ssTot = 0;
  let zMin = Number.POSITIVE_INFINITY;
  let zMax = Number.NEGATIVE_INFINITY;
  for (const { u, v, z } of points) {
    const r = z - (a + b * u + c * v + d * u * u + e * u * v + f * v * v);
    residualMin = Math.min(residualMin, r);
    residualMax = Math.max(residualMax, r);
    zMin = Math.min(zMin, z);
    zMax = Math.max(zMax, z);
    ssRes += r * r;
    ssTot += (z - mean) ** 2;
  }
  const explained = ssTot === 0 ? 1 : Math.max(0, 1 - ssRes / ssTot);
  const corners = [0, d, f, d + f];
  const components: ShapeComponents = {
    tilt: 2 * (Math.abs(b) + Math.abs(c)),
    curvature: Math.max(...corners) - Math.min(...corners),
    twist: 2 * Math.abs(e),
    residual: residualMax - residualMin,
  };

  const bigCurvature = Math.max(Math.abs(d), Math.abs(f));
  const curvatureAxis =
    bigCurvature === 0
      ? null
      : Math.min(Math.abs(d), Math.abs(f)) < SINGLE_AXIS_RATIO * bigCurvature
        ? Math.abs(d) > Math.abs(f)
          ? "x"
          : "y"
        : "both";
  const curvatureShape =
    curvatureAxis === "both" && Math.sign(d) !== Math.sign(f)
      ? "saddle"
      : (curvatureAxis === "x" ? d : curvatureAxis === "y" ? f : d + f) > 0
        ? "bowl"
        : "dome";
  const highDiagonal = e === 0 ? null : e > 0 ? "frontLeft-backRight" : "frontRight-backLeft";

  const ranked = (
    [
      ["tilted", components.tilt],
      [curvatureShape, components.curvature],
      ["twisted", components.twist],
    ] as const
  ).toSorted((x, y) => y[1] - x[1]);
  const [first, second] = [defined(ranked[0], "composante"), defined(ranked[1], "composante")];

  const base = { explained, components, curvatureAxis, highDiagonal } as const;
  const range = zMax - zMin;
  if (range <= tolerance) {
    // Plus l'amplitude approche la tolérance, moins le verdict « plat » est sûr.
    return { shape: "flat", confidence: 1 - range / tolerance, ...base };
  }
  // Aucune composante (grille d'une seule ligne et colonne utiles…) : rien n'explique la forme.
  if (explained < MIN_EXPLAINED || first[1] === 0) {
    return { shape: "irregular", confidence: 1 - explained, ...base };
  }
  const secondary =
    second[1] >= first[1] / 2 && second[1] >= tolerance / 2 ? { secondary: second[0] } : {};
  // Confiance : part expliquée × netteté de la dominance (0 si deux composantes égales).
  return {
    shape: first[0],
    confidence: explained * (1 - second[1] / first[1]),
    ...secondary,
    ...base,
  };
}
