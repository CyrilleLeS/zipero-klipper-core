// SPDX-License-Identifier: GPL-3.0-only
import { consoleLines } from "../text/console";
import type { MeshGeometry, MeshGrid } from "./types";

/**
 * Assistant de vis (EP-05.10), fidèle à klippy/extras/screws_tilt_adjust.py (Klipper commit
 * 214fdb2877) :
 * - la vis de base est la première (ou, avec DIRECTION, la plus haute ou la plus basse) ;
 * - écart = z(base) − z(vis) ; tours = écart / pas du filetage (M3 0,5 ; M4 0,7 ; M5 0,8 ;
 *   M6 1 mm) ; affichage « tours:minutes » (minutes de cadran, arrondies comme `round` de Python,
 *   au pair le plus proche) ; sous 0,001 mm, aucun réglage ;
 * - filetage CW : un tour dans le sens horaire RAPPROCHE le plateau de la buse (doc de Klipper).
 * La hauteur de chaque vis vient soit d'une vraie sortie SCREWS_TILT_CALCULATE, soit du
 * maillage, échantillonné comme `ZMesh.calc_z` à l'endroit où la sonde passe au-dessus de la vis.
 */

export const SCREW_THREADS = [
  "CW-M3",
  "CCW-M3",
  "CW-M4",
  "CCW-M4",
  "CW-M5",
  "CCW-M5",
  "CW-M6",
  "CCW-M6",
] as const;
export type ScrewThread = (typeof SCREW_THREADS)[number];

const PITCH: Record<string, number> = { M3: 0.5, M4: 0.7, M5: 0.8, M6: 1 };

export type TurnDirection = "CW" | "CCW";

export interface ScrewReading {
  readonly name: string;
  /** Position de la BUSE (mm), telle que déclarée dans [screws_tilt_adjust]. */
  readonly x: number;
  readonly y: number;
  /** Hauteur mesurée au-dessus de la vis (mm). */
  readonly z: number;
}

export interface ScrewAdjustment extends ScrewReading {
  readonly base: boolean;
  readonly direction: TurnDirection;
  readonly turns: number;
  readonly minutes: number;
  /** Format de Klipper : « 01:15 » (1 tour et 15 minutes de cadran). */
  readonly label: string;
}

/** `round(x, 0)` de Python 3 : moitiés arrondies au pair le plus proche. */
export function pythonRound(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

export function isScrewThread(value: string): value is ScrewThread {
  return (SCREW_THREADS as readonly string[]).includes(value);
}

/** Réglage de chaque vis, comme `probe_finalize` ; `direction` = option DIRECTION. */
export function screwsTiltAdjust(
  readings: readonly ScrewReading[],
  thread: ScrewThread = "CW-M3",
  direction?: TurnDirection,
): ScrewAdjustment[] {
  if (readings.length === 0) return [];
  const clockwiseThread = thread.startsWith("CW");
  const pitch = PITCH[thread.split("-")[1] ?? "M3"] ?? 0.5;
  let base = 0;
  if (direction) {
    const useMax =
      (clockwiseThread && direction === "CW") || (!clockwiseThread && direction === "CCW");
    readings.forEach((reading, index) => {
      const current = readings[base]?.z ?? reading.z;
      if (useMax ? reading.z > current : reading.z < current) base = index;
    });
  }
  const zBase = readings[base]?.z ?? 0;
  return readings.map((reading, index) => {
    if (index === base) {
      return {
        ...reading,
        base: true,
        direction: clockwiseThread ? "CW" : "CCW",
        turns: 0,
        minutes: 0,
        label: "00:00",
      };
    }
    const diff = zBase - reading.z;
    const adjust = Math.abs(diff) < 0.001 ? 0 : diff / pitch;
    const sign: TurnDirection = clockwiseThread
      ? adjust >= 0
        ? "CW"
        : "CCW"
      : adjust >= 0
        ? "CCW"
        : "CW";
    const magnitude = Math.abs(adjust);
    const turns = Math.trunc(magnitude);
    const minutes = pythonRound((magnitude - turns) * 60);
    const pad = (n: number) => String(n).padStart(2, "0");
    return {
      ...reading,
      base: false,
      direction: sign,
      turns,
      minutes,
      label: `${pad(turns)}:${pad(minutes)}`,
    };
  });
}

export interface MeshSample {
  readonly z: number;
  /** true si le point est hors de la zone du maillage : Klipper prend alors la valeur du bord. */
  readonly clamped: boolean;
}

/** Hauteur du maillage en (x, y) coordonnées de SONDE, comme `ZMesh.calc_z` (bilinéaire). */
export function sampleMesh(
  surface: MeshGrid,
  geometry: MeshGeometry,
  x: number,
  y: number,
): MeshSample {
  const axis = (coord: number, min: number, max: number, count: number) => {
    const dist = (max - min) / (count - 1);
    const raw = Math.floor((coord - min) / dist);
    const index = Math.min(Math.max(raw, 0), count - 2);
    const t = (coord - (min + dist * index)) / dist;
    return { index, t: Math.min(Math.max(t, 0), 1), clamped: t < 0 || t > 1 };
  };
  const ax = axis(x, geometry.minX, geometry.maxX, surface.cols);
  const ay = axis(y, geometry.minY, geometry.maxY, surface.rows);
  const at = (row: number, col: number) => surface.values[row]?.[col] ?? 0;
  const lerp = (t: number, a: number, b: number) => (1 - t) * a + t * b;
  const z0 = lerp(ax.t, at(ay.index, ax.index), at(ay.index, ax.index + 1));
  const z1 = lerp(ax.t, at(ay.index + 1, ax.index), at(ay.index + 1, ax.index + 1));
  return { z: lerp(ay.t, z0, z1), clamped: ax.clamped || ay.clamped };
}

export interface ScrewFromMesh extends ScrewReading {
  /** Vis hors de la zone mesurée : hauteur prise au bord du maillage (estimation). */
  readonly outsideMesh: boolean;
}

/**
 * Hauteurs des vis lues sur le maillage : la sonde est au-dessus de la vis quand la buse est
 * aux coordonnées déclarées, donc au point (x + x_offset, y + y_offset).
 */
export function screwReadingsFromMesh(
  surface: MeshGrid,
  geometry: MeshGeometry,
  screws: readonly { readonly x: number; readonly y: number; readonly name?: string }[],
  probeOffset: { readonly x: number; readonly y: number },
): ScrewFromMesh[] {
  return screws.map((screw) => {
    const sample = sampleMesh(surface, geometry, screw.x + probeOffset.x, screw.y + probeOffset.y);
    return {
      // Nom par défaut de Klipper : « screw at x,y » (3 décimales).
      name: screw.name ?? `screw at ${screw.x.toFixed(3)},${screw.y.toFixed(3)}`,
      x: screw.x,
      y: screw.y,
      z: sample.z,
      outsideMesh: sample.clamped,
    };
  });
}

export interface ParsedScrewLine extends ScrewReading {
  readonly base: boolean;
  /** Réglage affiché par Klipper (absent pour la vis de base). */
  readonly printed?: {
    readonly direction: TurnDirection;
    readonly turns: number;
    readonly minutes: number;
  };
}

const SCREW_LINE =
  /^(.+?)\s*(\(base\))?\s*:\s*x=(-?[\d.]+),\s*y=(-?[\d.]+),\s*z=(-?[\d.]+)(?:\s*:\s*adjust\s+(CW|CCW)\s+(\d{2}):(\d{2}))?/;

/**
 * Lit une sortie console de SCREWS_TILT_CALCULATE (préfixes « // », « Recv: », horodatages
 * tolérés). Un nouveau passage commence à chaque vis déjà vue.
 */
export function parseScrewsTiltOutput(text: string): ParsedScrewLine[][] {
  const runs: ParsedScrewLine[][] = [];
  let current: ParsedScrewLine[] = [];
  for (const { content } of consoleLines(text)) {
    const match = SCREW_LINE.exec(content.replace(/^Recv:\s*(?:\/\/\s*)?/, ""));
    if (!match) continue;
    const [, name = "", base, x = "", y = "", z = "", direction, turns, minutes] = match;
    const line: ParsedScrewLine = {
      name: name.trim(),
      x: Number(x),
      y: Number(y),
      z: Number(z),
      base: base !== undefined,
      ...(direction
        ? {
            printed: {
              direction: direction as TurnDirection,
              turns: Number(turns),
              minutes: Number(minutes),
            },
          }
        : {}),
    };
    if (current.some((screw) => screw.name === line.name)) {
      runs.push(current);
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) runs.push(current);
  return runs;
}
