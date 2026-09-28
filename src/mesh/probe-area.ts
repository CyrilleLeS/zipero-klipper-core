// SPDX-License-Identifier: GPL-3.0-only
import { ANALYSIS_LIMITS } from "../limits";
import type { PrinterMechanics } from "../printers/extract";
import { failure, type Issue, type ParseResult, success } from "../result";

/**
 * Validation de la zone sondée (EP-05.13) : chaque point du maillage est-il atteignable ?
 *
 * Dans Klipper, `mesh_min` / `mesh_max` (et `mesh_radius` / `mesh_origin`) sont des coordonnées
 * de la SONDE. Pour sonder le point (x, y), la buse va en (x − x_offset, y − y_offset)
 * (bed_mesh.py, `print_generated_points`, colonne « Tool Adjusted »), et cette position doit
 * rester dans la course [position_min, position_max] de chaque axe, sinon BED_MESH_CALIBRATE
 * échoue sur « Move out of range ».
 *
 * Les points sont générés comme `ProbeManager.generate_points` de Klipper :
 * - pas arrondi au centième inférieur, erreur sous 1 mm ;
 * - plateau rectangulaire : `max_x` recalculé depuis `min_x` et le pas arrondi ;
 * - plateau rond : rayon arrondi au dixième inférieur, pas identique sur X et Y, points gardés
 *   s'ils sont à moins du rayon de l'origine, puis décalés de `mesh_origin`.
 * Hors du périmètre : le dépassement des déplacements de balayage (`scan_overshoot`).
 */

/** Tous les codes possibles (l'interface vérifie qu'ils sont tous traduits). */
export const PROBE_AREA_CODES = [
  "probeArea.noMesh",
  "probeArea.noTravel",
  "probeArea.noProbe",
  "probeArea.invalidMinMax",
  "probeArea.tooClose",
  "probeArea.roundCountEven",
  "probeArea.countTooLow",
  "probeArea.countTooHigh",
  "probeArea.outOfRange",
] as const;

export type ProbeAreaCode = (typeof PROBE_AREA_CODES)[number];

export interface ProbePoint {
  readonly x: number;
  readonly y: number;
}

export interface Bounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

export interface ProbeArea {
  readonly shape: "rectangular" | "round";
  /** Points sondés, en coordonnées de la sonde, dans l'ordre de passage de Klipper. */
  readonly points: readonly ProbePoint[];
  /** Emprise des points sondés (coordonnées de la sonde). */
  readonly probed: Bounds;
  /** Zone que la sonde peut atteindre : course des axes décalée de l'offset de la sonde. */
  readonly reachable: Bounds;
  /**
   * Dépassements, un par axe et par côté. Paramètres : `axis` (x | y), `side` (min | max),
   * `excess` (mm) et `suggested` : valeur de `mesh_min` / `mesh_max` (ou `mesh_radius`) qui tient
   * dans la zone atteignable, arrondie au dixième vers l'intérieur.
   */
  readonly problems: readonly Issue<ProbeAreaCode>[];
}

const DEFAULT_PROBE_COUNT = 3;
const DEFAULT_ROUND_PROBE_COUNT = 5;
/** Tolérance d'arrondi flottant (Klipper compare des flottants issus des mêmes calculs). */
const EPSILON = 1e-9;

const floorTo = (value: number, step: number) => Math.floor(value / step + EPSILON) * step;
const round2 = (value: number) => Math.round(value * 100) / 100;
const inward = (value: number, side: "min" | "max") =>
  // Vers l'intérieur au dixième : un minimum s'arrondit vers le haut, un maximum vers le bas.
  side === "min" ? Math.ceil(value * 10 - EPSILON) / 10 : Math.floor(value * 10 + EPSILON) / 10;

function rectangularPoints(
  min: readonly [number, number],
  max: readonly [number, number],
  count: readonly [number, number],
): ProbePoint[] | ProbeAreaCode {
  const [xCount, yCount] = count;
  // Klipper : probe_count lu avec minval=3.
  if (xCount < 3 || yCount < 3) return "probeArea.countTooLow";
  if (xCount * yCount > ANALYSIS_LIMITS.maxProbePoints) return "probeArea.countTooHigh";
  if (max[0] <= min[0] || max[1] <= min[1]) return "probeArea.invalidMinMax";
  const xDist = floorTo((max[0] - min[0]) / (xCount - 1), 0.01);
  const yDist = floorTo((max[1] - min[1]) / (yCount - 1), 0.01);
  if (xDist < 1 || yDist < 1) return "probeArea.tooClose";
  const points: ProbePoint[] = [];
  for (let i = 0; i < yCount; i++) {
    for (let j = 0; j < xCount; j++) {
      // Aller-retour (serpentin) comme Klipper : l'ordre compte pour l'affichage du trajet.
      const col = i % 2 === 0 ? j : xCount - 1 - j;
      points.push({ x: min[0] + col * xDist, y: min[1] + i * yDist });
    }
  }
  return points;
}

function roundPoints(
  configuredRadius: number,
  origin: readonly [number, number],
  count: number,
): ProbePoint[] | ProbeAreaCode {
  if (count < 3) return "probeArea.countTooLow";
  if (count % 2 === 0) return "probeArea.roundCountEven";
  if (count * count > ANALYSIS_LIMITS.maxProbePoints) return "probeArea.countTooHigh";
  const radius = floorTo(configuredRadius, 0.1);
  const dist = floorTo((2 * radius) / (count - 1), 0.01);
  if (dist < 1) return "probeArea.tooClose";
  const newRadius = Math.floor(count / 2) * dist;
  const points: ProbePoint[] = [];
  for (let i = 0; i < count; i++) {
    const y = -newRadius + i * dist;
    for (let j = 0; j < count; j++) {
      const x = i % 2 === 0 ? -newRadius + j * dist : newRadius - j * dist;
      if (Math.sqrt(x * x + y * y) <= radius + EPSILON) {
        points.push({ x: origin[0] + x, y: origin[1] + y });
      }
    }
  }
  return points;
}

function boundsOf(points: readonly ProbePoint[]): Bounds {
  return points.reduce(
    (b, p) => ({
      minX: Math.min(b.minX, p.x),
      maxX: Math.max(b.maxX, p.x),
      minY: Math.min(b.minY, p.y),
      maxY: Math.max(b.maxY, p.y),
    }),
    {
      minX: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
    },
  );
}

export function checkProbeArea(mechanics: PrinterMechanics): ParseResult<ProbeArea, ProbeAreaCode> {
  const { mesh, travel, probe } = mechanics;
  if (!mesh) return failure({ code: "probeArea.noMesh" });
  if (!travel) return failure({ code: "probeArea.noTravel" });
  if (!probe) return failure({ code: "probeArea.noProbe" });

  const round = mesh.radius !== undefined;
  const origin = mesh.origin ?? [0, 0];
  const roundCount = mesh.roundProbeCount ?? DEFAULT_ROUND_PROBE_COUNT;
  const generated =
    mesh.radius !== undefined
      ? roundPoints(mesh.radius, origin, roundCount)
      : mesh.min && mesh.max
        ? rectangularPoints(
            mesh.min,
            mesh.max,
            mesh.probeCount ?? [DEFAULT_PROBE_COUNT, DEFAULT_PROBE_COUNT],
          )
        : "probeArea.noMesh";
  if (typeof generated === "string") return failure({ code: generated });

  const probed = boundsOf(generated);
  const reachable: Bounds = {
    minX: travel.minX + probe.xOffset,
    maxX: travel.maxX + probe.xOffset,
    minY: travel.minY + probe.yOffset,
    maxY: travel.maxY + probe.yOffset,
  };

  const fits = (b: Bounds) =>
    b.minX >= reachable.minX - EPSILON &&
    b.maxX <= reachable.maxX + EPSILON &&
    b.minY >= reachable.minY - EPSILON &&
    b.maxY <= reachable.maxY + EPSILON;
  // Plateau rond : plus grand rayon (au dixième) dont les points regénérés tiennent tous.
  const largestRadius = () => {
    for (let r = floorTo(mesh.radius ?? 0, 0.1); r > 0; r = Math.round((r - 0.1) * 10) / 10) {
      const candidate = roundPoints(r, origin, roundCount);
      if (typeof candidate === "string") return 0;
      if (fits(boundsOf(candidate))) return r;
    }
    return 0;
  };

  const problems: Issue<ProbeAreaCode>[] = [];
  const check = (axis: "x" | "y", side: "min" | "max") => {
    const key = `${side}${axis.toUpperCase()}` as keyof Bounds;
    const excess = side === "min" ? reachable[key] - probed[key] : probed[key] - reachable[key];
    if (excess <= EPSILON) return;
    const suggested = round ? largestRadius() : inward(reachable[key], side);
    problems.push({
      code: "probeArea.outOfRange",
      params: { axis, side, excess: round2(excess), suggested },
    });
  };
  check("x", "min");
  check("x", "max");
  check("y", "min");
  check("y", "max");

  return success({
    shape: round ? "round" : "rectangular",
    points: generated,
    probed,
    reachable,
    problems,
  });
}
