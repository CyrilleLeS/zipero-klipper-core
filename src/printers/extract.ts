// SPDX-License-Identifier: GPL-3.0-only
import type { ConfigSection } from "../config/ini";

/**
 * Extraction des caractéristiques mécaniques d'une imprimante depuis sa configuration Klipper
 * (EP-11.07, EP-03.13, EP-06.05). Uniquement les sections ACTIVES : une valeur en commentaire
 * n'est pas une valeur. Une donnée absente reste absente (jamais de valeur supposée).
 */

/**
 * Cinématiques à axes X/Y rectilignes dont la course se lit dans [stepper_x] / [stepper_y].
 * `limited_*` : cinématiques du fork Kalico (vérifié dans son dépôt le 28/09/2026).
 * `generic_cartesian` (Klipper) déclare ses axes en [carriage …] : non pris en charge ici.
 */
const RECTILINEAR = new Set([
  "cartesian",
  "corexy",
  "corexz",
  "hybrid_corexy",
  "hybrid_corexz",
  "limited_cartesian",
  "limited_corexy",
  "limited_corexz",
]);

/**
 * Sections de sonde reconnues (le nom de base identifie le type). `load_cell_probe` : Klipper
 * (x_offset/y_offset via ProbeOffsetsHelper). `prtouch_v2`/`prtouch` : capteurs de pression du fork
 * Creality (K1, K1C…), la buse elle-même sonde : décalage nul faute d'option.
 */
const PROBE_SECTIONS = [
  "probe",
  "bltouch",
  "smart_effector",
  "probe_eddy_current",
  "load_cell_probe",
  "beacon",
  "cartographer",
  "scanner",
  "prtouch_v2",
  "prtouch",
] as const;

export interface Travel {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly maxZ?: number;
}

export interface ProbeInfo {
  /** Nom de la section (bltouch, probe, beacon…). */
  readonly type: string;
  readonly xOffset: number;
  readonly yOffset: number;
}

export interface ScrewPoint {
  readonly x: number;
  readonly y: number;
  readonly name?: string;
}

export interface ScrewsInfo {
  /** Section d'origine : les coordonnées de `screws_tilt_adjust` sont celles de la BUSE. */
  readonly source: "screws_tilt_adjust" | "bed_screws";
  readonly points: readonly ScrewPoint[];
  /** Filetage déclaré (`screw_thread`, ex. CW-M3), pour screws_tilt_adjust. */
  readonly thread?: string;
}

export interface MeshSettings {
  readonly min?: readonly [number, number];
  readonly max?: readonly [number, number];
  readonly probeCount?: readonly [number, number];
  /** Plateau rond : `mesh_radius`, `mesh_origin`, `round_probe_count`. */
  readonly radius?: number;
  readonly origin?: readonly [number, number];
  readonly roundProbeCount?: number;
}

export interface PrinterMechanics {
  readonly kinematics?: string;
  /** Course des axes (position_min → position_max) ; absente hors cinématique rectiligne. */
  readonly travel?: Travel;
  readonly probe?: ProbeInfo;
  readonly screws?: ScrewsInfo;
  readonly mesh?: MeshSettings;
}

const toNumber = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return /^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(trimmed) ? Number(trimmed) : undefined;
};

/** « 30, 30 » → [30, 30] ; undefined si la valeur n'est pas un couple de nombres. */
const toPair = (value: string | undefined): readonly [number, number] | undefined => {
  const parts = value?.split(",").map((part) => toNumber(part));
  if (parts?.length !== 2) return undefined;
  const [a, b] = parts;
  return a === undefined || b === undefined ? undefined : [a, b];
};

const section = (sections: readonly ConfigSection[], name: string) =>
  sections.find((s) => s.name === name);

function readTravel(sections: readonly ConfigSection[], kinematics: string | undefined) {
  if (!kinematics || !RECTILINEAR.has(kinematics)) return undefined;
  const axis = (name: string) => {
    const stepper = section(sections, `stepper_${name}`);
    const max = toNumber(stepper?.options.get("position_max")?.value);
    // position_min vaut 0 par défaut dans Klipper.
    const min = toNumber(stepper?.options.get("position_min")?.value) ?? 0;
    return max === undefined ? undefined : { min, max };
  };
  const x = axis("x");
  const y = axis("y");
  const z = axis("z");
  if (!x || !y) return undefined;
  return {
    minX: x.min,
    maxX: x.max,
    minY: y.min,
    maxY: y.max,
    ...(z ? { maxZ: z.max } : {}),
  };
}

function readProbe(sections: readonly ConfigSection[]): ProbeInfo | undefined {
  for (const s of sections) {
    const type = s.name.split(/\s+/)[0] ?? "";
    if (!(PROBE_SECTIONS as readonly string[]).includes(type)) continue;
    return {
      type,
      xOffset: toNumber(s.options.get("x_offset")?.value) ?? 0,
      yOffset: toNumber(s.options.get("y_offset")?.value) ?? 0,
    };
  }
  return undefined;
}

function readScrews(sections: readonly ConfigSection[]): ScrewsInfo | undefined {
  for (const source of ["screws_tilt_adjust", "bed_screws"] as const) {
    const s = section(sections, source);
    if (!s) continue;
    const points: ScrewPoint[] = [];
    // Comme Klipper (bed_screws.py, screws_tilt_adjust.py) : screw1 à screw99, arrêt au
    // premier numéro absent.
    for (let i = 1; i <= 99; i++) {
      const position = toPair(s.options.get(`screw${i}`)?.value);
      if (!position) break;
      const name = s.options.get(`screw${i}_name`)?.value;
      points.push({ x: position[0], y: position[1], ...(name ? { name } : {}) });
    }
    if (points.length === 0) continue;
    const thread = s.options.get("screw_thread")?.value;
    return { source, points, ...(thread ? { thread } : {}) };
  }
  return undefined;
}

function readMesh(sections: readonly ConfigSection[]): MeshSettings | undefined {
  const s = section(sections, "bed_mesh");
  if (!s) return undefined;
  const min = toPair(s.options.get("mesh_min")?.value);
  const max = toPair(s.options.get("mesh_max")?.value);
  const count = s.options.get("probe_count")?.value;
  // probe_count accepte « 5 » (même valeur sur X et Y) ou « 5, 3 ».
  const single = toNumber(count);
  const probeCount = single !== undefined ? ([single, single] as const) : toPair(count);
  const radius = toNumber(s.options.get("mesh_radius")?.value);
  const origin = toPair(s.options.get("mesh_origin")?.value);
  const roundProbeCount = toNumber(s.options.get("round_probe_count")?.value);
  return {
    ...(min ? { min } : {}),
    ...(max ? { max } : {}),
    ...(probeCount ? { probeCount } : {}),
    ...(radius !== undefined ? { radius } : {}),
    ...(origin ? { origin } : {}),
    ...(roundProbeCount !== undefined ? { roundProbeCount } : {}),
  };
}

export function extractPrinterMechanics(sections: readonly ConfigSection[]): PrinterMechanics {
  const kinematics = section(sections, "printer")?.options.get("kinematics")?.value;
  const travel = readTravel(sections, kinematics);
  const probe = readProbe(sections);
  const screws = readScrews(sections);
  const mesh = readMesh(sections);
  return {
    ...(kinematics ? { kinematics } : {}),
    ...(travel ? { travel } : {}),
    ...(probe ? { probe } : {}),
    ...(screws ? { screws } : {}),
    ...(mesh ? { mesh } : {}),
  };
}
