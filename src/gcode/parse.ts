// SPDX-License-Identifier: GPL-3.0-only
import type { Issue } from "../result";
import { roleIndex } from "./roles";

/**
 * Lecture d'un G-code (EP-04, ADR 0006), octet par octet, sans créer de chaîne par ligne : un
 * fichier de 80 Mo se lit en une seconde sur un téléphone. Sortie en tableaux typés, prêts à être
 * transférés du worker à l'affichage sans copie : segments d'extrusion (2 sommets chacun), rôle,
 * outil, vitesse et filament par segment, début et hauteur de chaque couche.
 *
 * Commandes interprétées : G0, G1, G2/G3 (arcs dans le plan XY, par I/J ou R), G10/G11
 * (rétraction du firmware), G20/G21 (pouces, millimètres), G28 (origine), G90/G91, G92, M82/M83,
 * T0–T15. Commentaires `;` (dont `;TYPE:` et `; FEATURE:` pour le rôle), numéros de ligne `N…`
 * et sommes de contrôle `*…` ignorés. Les autres commandes (macros, températures…) n'affectent
 * pas la trajectoire.
 */

export interface GcodeParseOptions {
  /** Segments conservés au plus (EP-16.02) ; au-delà, lecture arrêtée et signalée. */
  readonly maxSegments?: number;
  /** Longueur d'un segment d'arc, en mm (1 mm, comme `mm_per_arc_segment` par défaut). */
  readonly arcSegmentMm?: number;
}

export type GcodeWarningCode = "gcode.segmentLimit" | "gcode.arcInvalid" | "gcode.nonFinite";

export interface GcodeStats {
  readonly lines: number;
  readonly travels: number;
  readonly retractions: number;
  readonly toolChanges: number;
  readonly arcs: number;
  /** Filament extrudé, en mm (somme des extrusions positives). */
  readonly filamentMm: number;
}

export interface GcodeToolpath {
  /** x, y, z du début puis de la fin de chaque segment (6 valeurs par segment). */
  readonly positions: Float32Array;
  /** Indice dans `GCODE_ROLES`. */
  readonly roles: Uint8Array;
  readonly tools: Uint8Array;
  /** Vitesse demandée, en mm/s. */
  readonly feedrates: Float32Array;
  /** Filament poussé pendant le segment, en mm. */
  readonly extrusions: Float32Array;
  /** Indice du premier segment de chaque couche. */
  readonly layerStarts: Uint32Array;
  /** Hauteur de chaque couche (mm). */
  readonly layerZ: Float32Array;
  readonly segments: number;
  /** [minX, minY, minZ, maxX, maxY, maxZ] des segments d'extrusion ; zéros si aucun. */
  readonly bounds: readonly [number, number, number, number, number, number];
  readonly stats: GcodeStats;
  readonly truncated: boolean;
  readonly warnings: readonly Issue<GcodeWarningCode>[];
}

export const GCODE_LIMITS = {
  maxSegments: 10_000_000,
  /** Segments d'un seul arc au plus (un rayon aberrant ne fait pas exploser la mémoire). */
  maxArcSegments: 2_000,
} as const;

const SEMICOLON = 59;
const NEWLINE = 10;
const CR = 13;
const SPACE = 32;
const TAB = 9;
const STAR = 42;
const MINUS = 45;
const PLUS = 43;
const DOT = 46;
const isDigit = (c: number) => c >= 48 && c <= 57;
const isLetter = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const upper = (c: number) => (c >= 97 ? c - 32 : c);
const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const TYPE_PREFIX = ascii(";TYPE:");
const FEATURE_PREFIX = ascii("; FEATURE:");
/** Texte ASCII d'une plage d'octets (noms de rôle des slicers). */
function asciiText(bytes: Uint8Array, from: number, to: number): string {
  let text = "";
  for (let k = from; k < to; k++) text += String.fromCharCode(bytes[k] ?? 0);
  return text;
}

/** Une couche commence quand on extrude plus haut que la précédente d'au moins ceci (mm). */
const LAYER_EPSILON = 1e-3;

/** Tableaux de sortie à capacité croissante (doublement). */
class Buffers {
  capacity = 1 << 15;
  positions = new Float32Array(this.capacity * 6);
  roles = new Uint8Array(this.capacity);
  tools = new Uint8Array(this.capacity);
  feedrates = new Float32Array(this.capacity);
  extrusions = new Float32Array(this.capacity);

  grow(limit: number) {
    const capacity = Math.min(this.capacity * 2, limit);
    const copy = <T extends Float32Array | Uint8Array>(
      from: T,
      make: (n: number) => T,
      n: number,
    ) => {
      const to = make(n);
      to.set(from);
      return to;
    };
    this.positions = copy(this.positions, (n) => new Float32Array(n), capacity * 6);
    this.roles = copy(this.roles, (n) => new Uint8Array(n), capacity);
    this.tools = copy(this.tools, (n) => new Uint8Array(n), capacity);
    this.feedrates = copy(this.feedrates, (n) => new Float32Array(n), capacity);
    this.extrusions = copy(this.extrusions, (n) => new Float32Array(n), capacity);
    this.capacity = capacity;
  }
}

export function parseGcode(bytes: Uint8Array, options: GcodeParseOptions = {}): GcodeToolpath {
  const maxSegments = Math.max(1, options.maxSegments ?? GCODE_LIMITS.maxSegments);
  const arcSegmentMm = Math.max(0.01, options.arcSegmentMm ?? 1);
  const out = new Buffers();
  const warnings: Issue<GcodeWarningCode>[] = [];
  const warned = new Set<GcodeWarningCode>();
  const warn = (code: GcodeWarningCode, line: number) => {
    if (warned.has(code)) return;
    warned.add(code);
    warnings.push({ code, line });
  };

  const layerStarts: number[] = [];
  const layerZ: number[] = [];
  let segments = 0;
  let truncated = false;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  let currentLayerZ = -Infinity;

  // État de la machine.
  let x = 0;
  let y = 0;
  let z = 0;
  let e = 0;
  let feed = 0;
  let absolute = true;
  let absoluteE = true;
  let scale = 1;
  let role = 0;
  let tool = 0;
  let stats = { lines: 0, travels: 0, retractions: 0, toolChanges: 0, arcs: 0, filamentMm: 0 };

  /** Ajoute un segment d'extrusion ; false si la limite est atteinte. */
  const push = (
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    ext: number,
  ) => {
    if (segments >= maxSegments) {
      truncated = true;
      return false;
    }
    if (segments >= out.capacity) out.grow(maxSegments);
    if (z1 > currentLayerZ + LAYER_EPSILON) {
      currentLayerZ = z1;
      layerStarts.push(segments);
      layerZ.push(z1);
    }
    const o = segments * 6;
    const p = out.positions;
    p[o] = x0;
    p[o + 1] = y0;
    p[o + 2] = z0;
    p[o + 3] = x1;
    p[o + 4] = y1;
    p[o + 5] = z1;
    out.roles[segments] = role;
    out.tools[segments] = tool;
    out.feedrates[segments] = feed / 60;
    out.extrusions[segments] = ext;
    minX = Math.min(minX, x0, x1);
    minY = Math.min(minY, y0, y1);
    minZ = Math.min(minZ, z0, z1);
    maxX = Math.max(maxX, x0, x1);
    maxY = Math.max(maxY, y0, y1);
    maxZ = Math.max(maxZ, z0, z1);
    segments++;
    return true;
  };

  // Mots de la ligne en cours (NaN : absent).
  const word = new Float64Array(26);
  const startsWith = (at: number, end: number, prefix: readonly number[]) => {
    if (end - at < prefix.length) return false;
    for (let k = 0; k < prefix.length; k++) if (bytes[at + k] !== prefix[k]) return false;
    return true;
  };

  const length = bytes.length;
  let i = 0;
  let lineNumber = 0;
  while (i < length && !truncated) {
    lineNumber++;
    let end = i;
    while (end < length && bytes[end] !== NEWLINE) end++;
    let stop = end;
    if (stop > i && bytes[stop - 1] === CR) stop--;
    while (i < stop && (bytes[i] === SPACE || bytes[i] === TAB)) i++;

    // Commentaire de rôle.
    if (bytes[i] === SEMICOLON) {
      const prefix = startsWith(i, stop, TYPE_PREFIX)
        ? TYPE_PREFIX
        : startsWith(i, stop, FEATURE_PREFIX)
          ? FEATURE_PREFIX
          : undefined;
      if (prefix) role = roleIndex(asciiText(bytes, i + prefix.length, stop));
      i = end + 1;
      continue;
    }

    // Mots de la ligne : lettre puis nombre, jusqu'au commentaire ou à la somme de contrôle.
    word.fill(Number.NaN);
    let command = -1;
    let code = Number.NaN;
    let j = i;
    while (j < stop) {
      const c = bytes[j] ?? 0;
      if (c === SEMICOLON || c === STAR) break;
      if (!isLetter(c)) {
        j++;
        continue;
      }
      const letter = upper(c);
      let k = j + 1;
      while (k < stop && (bytes[k] === SPACE || bytes[k] === TAB)) k++;
      let sign = 1;
      if (bytes[k] === MINUS) {
        sign = -1;
        k++;
      } else if (bytes[k] === PLUS) k++;
      let value = 0;
      let digits = 0;
      while (k < stop && isDigit(bytes[k] ?? 0)) {
        value = value * 10 + ((bytes[k] ?? 0) - 48);
        k++;
        digits++;
      }
      if (bytes[k] === DOT) {
        k++;
        let unit = 0.1;
        while (k < stop && isDigit(bytes[k] ?? 0)) {
          value += ((bytes[k] ?? 0) - 48) * unit;
          unit *= 0.1;
          k++;
          digits++;
        }
      }
      if (digits === 0) {
        // Lettre isolée (début d'une macro comme PRINT_START) : pas une commande G-code.
        if (command === -1) break;
        // Axe nommé sans valeur (`G28 X`) : présent, valeur 0.
        if (letter !== 78) word[letter - 65] = 0;
        j = k;
        continue;
      }
      value *= sign;
      if (command === -1 && (letter === 71 || letter === 77 || letter === 84) /* G M T */) {
        command = letter;
        code = value;
      } else if (letter !== 78 /* N */) {
        word[letter - 65] = value;
      }
      j = k;
    }
    i = end + 1;
    if (command === -1) continue;
    stats.lines++;

    if (command === 84 /* T */) {
      const next = Math.trunc(code);
      if (next >= 0 && next <= 15 && next !== tool) {
        tool = next;
        stats.toolChanges++;
      }
      continue;
    }
    if (command === 77 /* M */) {
      if (code === 82) absoluteE = true;
      else if (code === 83) absoluteE = false;
      continue;
    }
    // Commandes G.
    if (code === 90) absolute = true;
    else if (code === 91) absolute = false;
    else if (code === 20) scale = 25.4;
    else if (code === 21) scale = 1;
    else if (code === 10) stats.retractions++;
    else if (code === 92) {
      if (!Number.isNaN(word[23] ?? Number.NaN)) x = (word[23] ?? 0) * scale;
      if (!Number.isNaN(word[24] ?? Number.NaN)) y = (word[24] ?? 0) * scale;
      if (!Number.isNaN(word[25] ?? Number.NaN)) z = (word[25] ?? 0) * scale;
      if (!Number.isNaN(word[4] ?? Number.NaN)) e = (word[4] ?? 0) * scale;
    } else if (code === 28) {
      const any = [23, 24, 25].some((w) => !Number.isNaN(word[w] ?? Number.NaN));
      if (!any || !Number.isNaN(word[23] ?? Number.NaN)) x = 0;
      if (!any || !Number.isNaN(word[24] ?? Number.NaN)) y = 0;
      if (!any || !Number.isNaN(word[25] ?? Number.NaN)) z = 0;
    } else if (code === 0 || code === 1 || code === 2 || code === 3) {
      const wx = word[23] ?? Number.NaN;
      const wy = word[24] ?? Number.NaN;
      const wz = word[25] ?? Number.NaN;
      const we = word[4] ?? Number.NaN;
      const wf = word[5] ?? Number.NaN;
      if (!Number.isNaN(wf)) feed = wf * scale;
      const tx = Number.isNaN(wx) ? x : absolute ? wx * scale : x + wx * scale;
      const ty = Number.isNaN(wy) ? y : absolute ? wy * scale : y + wy * scale;
      const tz = Number.isNaN(wz) ? z : absolute ? wz * scale : z + wz * scale;
      let delta = 0;
      let te = e;
      if (!Number.isNaN(we)) {
        te = absoluteE ? we * scale : e + we * scale;
        delta = te - e;
      }
      if (![tx, ty, tz, te].every(Number.isFinite)) {
        warn("gcode.nonFinite", lineNumber);
        continue;
      }
      const moves = tx !== x || ty !== y;
      if (!moves && delta < 0) stats.retractions++;

      if (code === 2 || code === 3) {
        stats.arcs++;
        const wi = word[8] ?? Number.NaN;
        const wj = word[9] ?? Number.NaN;
        const wr = word[17] ?? Number.NaN;
        let cx: number;
        let cy: number;
        if (!Number.isNaN(wi) || !Number.isNaN(wj)) {
          cx = x + (Number.isNaN(wi) ? 0 : wi * scale);
          cy = y + (Number.isNaN(wj) ? 0 : wj * scale);
        } else if (!Number.isNaN(wr) && moves) {
          // Centre depuis le rayon : à gauche (G3) ou à droite (G2) de la corde ; R < 0 : grand arc.
          const r = Math.abs(wr * scale);
          const dx = tx - x;
          const dy = ty - y;
          const chord = Math.hypot(dx, dy);
          if (chord > 2 * r + 1e-6) {
            warn("gcode.arcInvalid", lineNumber);
            x = tx;
            y = ty;
            z = tz;
            e = te;
            continue;
          }
          const h = Math.sqrt(Math.max(0, r * r - (chord / 2) ** 2));
          const side = (code === 3 ? 1 : -1) * (wr < 0 ? -1 : 1);
          cx = x + dx / 2 - (side * h * dy) / chord;
          cy = y + dy / 2 + (side * h * dx) / chord;
        } else {
          warn("gcode.arcInvalid", lineNumber);
          x = tx;
          y = ty;
          z = tz;
          e = te;
          continue;
        }
        const radius = Math.hypot(x - cx, y - cy);
        const a0 = Math.atan2(y - cy, x - cx);
        let a1 = Math.atan2(ty - cy, tx - cx);
        let sweep = a1 - a0;
        if (code === 3 && sweep <= 1e-9) sweep += 2 * Math.PI;
        if (code === 2 && sweep >= -1e-9) sweep -= 2 * Math.PI;
        a1 = a0 + sweep;
        const arcLength = Math.abs(sweep) * radius;
        const pieces = Math.min(
          GCODE_LIMITS.maxArcSegments,
          Math.max(1, Math.ceil(arcLength / arcSegmentMm)),
        );
        if (delta > 0) stats.filamentMm += delta;
        let px = x;
        let py = y;
        let pz = z;
        for (let s = 1; s <= pieces; s++) {
          const t = s / pieces;
          const angle = a0 + sweep * t;
          const nx = s === pieces ? tx : cx + radius * Math.cos(angle);
          const ny = s === pieces ? ty : cy + radius * Math.sin(angle);
          const nz = z + (tz - z) * t;
          if (delta > 0 && !push(px, py, pz, nx, ny, nz, delta / pieces)) break;
          px = nx;
          py = ny;
          pz = nz;
        }
        if (delta <= 0) stats.travels++;
      } else if (moves || tz !== z) {
        if (delta > 0 && moves) {
          stats.filamentMm += delta;
          push(x, y, z, tx, ty, tz, delta);
        } else if (moves) {
          stats.travels++;
        }
      }
      x = tx;
      y = ty;
      z = tz;
      e = te;
    }
  }
  if (truncated) warn("gcode.segmentLimit", lineNumber);

  const take = <T extends Float32Array | Uint8Array>(array: T, n: number) => array.slice(0, n) as T;
  stats = { ...stats, filamentMm: Math.round(stats.filamentMm * 1000) / 1000 };
  return {
    positions: take(out.positions, segments * 6),
    roles: take(out.roles, segments),
    tools: take(out.tools, segments),
    feedrates: take(out.feedrates, segments),
    extrusions: take(out.extrusions, segments),
    layerStarts: Uint32Array.from(layerStarts),
    layerZ: Float32Array.from(layerZ),
    segments,
    bounds: segments === 0 ? [0, 0, 0, 0, 0, 0] : [minX, minY, minZ, maxX, maxY, maxZ],
    stats,
    truncated,
    warnings,
  };
}
