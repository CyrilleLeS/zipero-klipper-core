// SPDX-License-Identifier: GPL-3.0-only

import { parseConfig } from "../config/ini";
import { ANALYSIS_LIMITS } from "../limits";
import { extractPrinterMechanics, type PrinterMechanics } from "../printers/extract";
import {
  assessRepeatability,
  type ProbeAccuracyRun,
  parseProbeAccuracy,
  type RepeatabilityAssessment,
} from "../probe/accuracy";
import { failure, type Issue, type ParseResult, success } from "../result";
import { parseBedMeshOutput } from "./console";
import {
  DEFAULT_INTERPOLATION,
  type InterpolationParams,
  interpolateMesh,
  type MeshAlgorithm,
} from "./interpolate";
import { computeMeshMetrics, type MeshMetrics } from "./metrics";
import { checkProbeArea, type ProbeArea, type ProbeAreaCode } from "./probe-area";
import { parseMeshProfiles } from "./profiles";
import {
  isScrewThread,
  type ScrewAdjustment,
  type ScrewFromMesh,
  type ScrewThread,
  screwReadingsFromMesh,
  screwsTiltAdjust,
} from "./screws";
import { classifyMeshShape, type ShapeClassification } from "./shape";
import type { MeshGeometry, MeshGrid } from "./types";

/**
 * Rapport de l'outil Bed mesh (EP-05, EP-03.08) : une seule entrée, trois formats reconnus.
 * - Configuration (`printer.cfg`, avec ou sans bloc SAVE_CONFIG) : profils sauvegardés, contrôle
 *   de la zone sondée (EP-05.13) et assistant de vis (EP-05.10).
 * - Sortie console de BED_MESH_OUTPUT : maillage(s) affiché(s).
 * - Sortie console de PROBE_ACCURACY : répétabilité de la sonde (EP-05.16).
 * Chaque maillage reçoit ses métriques (EP-05.07), sa forme (EP-05.08) et un diagnostic textuel
 * par règles (EP-05.11) ; les diagnostics sont des codes triés par sévérité, traduits par
 * l'interface (le cœur ne produit aucun texte). Les seuils sont réglables (par imprimante).
 */

export type Severity = "critical" | "warning" | "info";

/** Tous les codes possibles (l'interface vérifie qu'ils sont tous traduits). */
export const BED_MESH_DIAGNOSTIC_CODES = [
  "bedMesh.probeAreaOutOfRange",
  "bedMesh.meshConfigInvalid",
  "bedMesh.probeCountTooHigh",
  "bedMesh.rangeLarge",
  "bedMesh.rangeModerate",
  "bedMesh.screwsAdjust",
  "bedMesh.tilted",
  "bedMesh.bowl",
  "bedMesh.dome",
  "bedMesh.saddle",
  "bedMesh.twisted",
  "bedMesh.irregular",
  "bedMesh.noisy",
  "bedMesh.flat",
  "bedMesh.probeGood",
  "bedMesh.probeBorderline",
  "bedMesh.probeInsufficient",
] as const;

export type BedMeshDiagnosticCode = (typeof BED_MESH_DIAGNOSTIC_CODES)[number];

export interface Diagnostic extends Issue<BedMeshDiagnosticCode> {
  readonly severity: Severity;
  /** Index du maillage (ou de la série PROBE_ACCURACY) concerné ; absent : la configuration. */
  readonly mesh?: number;
}

export type FlatnessGrade = "excellent" | "good" | "fair" | "poor";

export interface MeshScrews {
  readonly source: "screws_tilt_adjust" | "bed_screws";
  readonly thread: ScrewThread;
  /**
   * true : filetage déclaré par `screw_thread`, ou CW-M3 par défaut de Klipper pour
   * [screws_tilt_adjust]. false : [bed_screws] ne déclare pas de filetage (CW-M3 supposé).
   */
  readonly threadKnown: boolean;
  /** Hauteurs lues sur la surface interpolée, au-dessus de chaque vis. */
  readonly readings: readonly ScrewFromMesh[];
  /** Réglages calculés comme SCREWS_TILT_CALCULATE (première vis = base). */
  readonly adjustments: readonly ScrewAdjustment[];
}

export interface MeshAnalysis {
  /** Nom du profil ; absent pour une sortie console. */
  readonly name?: string;
  readonly line: number;
  readonly grid: MeshGrid;
  /** Emprise en mm (connue pour un profil ; pas dans la sortie console). */
  readonly geometry?: MeshGeometry;
  readonly metrics: MeshMetrics;
  readonly shape: ShapeClassification;
  readonly grade: FlatnessGrade;
  /**
   * Surface interpolée utilisée par Klipper (EP-05.05) : celle imprimée par la console si
   * présente, sinon recalculée (réglages du profil, ou réglages par défaut de Klipper).
   * Absente si Klipper refuserait ces réglages.
   */
  readonly interpolated?: {
    readonly grid: MeshGrid;
    readonly algorithm: MeshAlgorithm;
    readonly source: "klipper" | "computed";
  };
  /** Assistant de vis (EP-05.10), si la configuration décrit les vis du plateau. */
  readonly screws?: MeshScrews;
}

export interface ProbeAccuracyAnalysis extends ProbeAccuracyRun {
  readonly assessment: RepeatabilityAssessment;
}

export interface BedMeshReport {
  readonly input: "console" | "config" | "probe-accuracy";
  readonly meshes: readonly MeshAnalysis[];
  /** Séries PROBE_ACCURACY (entrée « probe-accuracy »). */
  readonly probeAccuracy?: readonly ProbeAccuracyAnalysis[];
  /** Contrôle de la zone sondée (configuration uniquement) : résultat ou raison de l'absence. */
  readonly probeArea?: ParseResult<ProbeArea, ProbeAreaCode>;
  readonly mechanics?: PrinterMechanics;
  readonly diagnostics: readonly Diagnostic[];
}

export interface FlatnessThresholds {
  readonly excellent: number;
  readonly good: number;
  readonly fair: number;
}

export interface BedMeshOptions {
  /** Seuils de la note de planéité (mm, crête à crête). */
  readonly flatness?: FlatnessThresholds;
  /** Bruit résiduel (RMS, mm) au-delà duquel la sonde est à vérifier. */
  readonly noise?: number;
}

/**
 * Seuils d'amplitude (mm, crête à crête) pour la note de planéité. Repères d'usage courant pour
 * un plateau compensé par maillage : jusqu'à 0,1 mm la première couche est uniforme ; au-delà de
 * 0,5 mm la compensation ne rattrape plus l'écrasement de la première couche partout. À affiner
 * avec les retours de la bêta (EP-19). Réglables par imprimante (EP-05.11).
 */
export const FLATNESS_THRESHOLDS: FlatnessThresholds = { excellent: 0.1, good: 0.2, fair: 0.5 };

/**
 * Bruit résiduel au-delà duquel on conseille de vérifier la sonde : 0,05 mm, environ le 90e
 * centile du corpus réel (médiane 0,021 mm, surtout des ondulations réelles du plateau). Un seul
 * maillage ne distingue pas le bruit de sonde d'un plateau ondulé : le diagnostic renvoie donc
 * vers PROBE_ACCURACY plutôt que de conclure.
 */
export const DEFAULT_NOISE_THRESHOLD = 0.05;
/** Bruit évalué seulement à partir de 16 points (4 × 4) : en dessous, l'ajustement colle aux points. */
const NOISE_MIN_POINTS = 16;
/** Un pic plus de 3 fois supérieur au RMS est un point isolé (défaut localisé), pas du bruit. */
const NOISE_PEAK_RATIO = 3;
/** Klipper : le plateau est réglé « quand tous les réglages sont sous 6 minutes » (Manual_Level). */
export const SCREWS_DONE_MINUTES = 6;

export function gradeFlatness(
  range: number,
  thresholds: FlatnessThresholds = FLATNESS_THRESHOLDS,
): FlatnessGrade {
  if (range <= thresholds.excellent) return "excellent";
  if (range <= thresholds.good) return "good";
  if (range <= thresholds.fair) return "fair";
  return "poor";
}

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
const round3 = (value: number) => Math.round(value * 1000) / 1000;

/** Assistant de vis pour une surface et une imprimante (vis, sonde) ; rien si non calculable. */
export function computeMeshScrews(
  surface: MeshGrid,
  geometry: MeshGeometry,
  mechanics: PrinterMechanics | undefined,
): MeshScrews | undefined {
  const screws = mechanics?.screws;
  if (!screws || screws.points.length < 3) return undefined;
  const tilt = screws.source === "screws_tilt_adjust";
  // [screws_tilt_adjust] : coordonnées de BUSE, sonde au-dessus de la vis → + décalage de sonde.
  // [bed_screws] : la buse est au-dessus de la vis → point du plateau = coordonnées déclarées.
  if (tilt && !mechanics.probe) return undefined;
  const offset =
    tilt && mechanics.probe
      ? { x: mechanics.probe.xOffset, y: mechanics.probe.yOffset }
      : { x: 0, y: 0 };
  const declared = screws.thread?.toUpperCase();
  const thread: ScrewThread = declared && isScrewThread(declared) ? declared : "CW-M3";
  const readings = screwReadingsFromMesh(surface, geometry, screws.points, offset);
  return {
    source: screws.source,
    thread,
    threadKnown: tilt,
    readings,
    adjustments: screwsTiltAdjust(readings, thread),
  };
}

function analyzeMesh(
  grid: MeshGrid,
  line: number,
  options: BedMeshOptions,
  extra: {
    name?: string;
    geometry?: MeshGeometry;
    interpolation?: InterpolationParams;
    printed?: { grid: MeshGrid; algorithm?: string };
    mechanics?: PrinterMechanics;
  },
): MeshAnalysis {
  const flatness = options.flatness ?? FLATNESS_THRESHOLDS;
  const metrics = computeMeshMetrics(grid, extra.geometry);
  const printedAlgorithm = extra.printed?.algorithm?.trim().toLowerCase();
  const computed = interpolateMesh(grid, extra.interpolation ?? DEFAULT_INTERPOLATION);
  const interpolated = extra.printed
    ? {
        grid: extra.printed.grid,
        algorithm: (printedAlgorithm === "bicubic" || printedAlgorithm === "direct"
          ? printedAlgorithm
          : "lagrange") as MeshAlgorithm,
        source: "klipper" as const,
      }
    : computed.ok
      ? { grid: computed.grid, algorithm: computed.algorithm, source: "computed" as const }
      : undefined;
  const screws =
    extra.geometry && extra.mechanics
      ? computeMeshScrews(interpolated?.grid ?? grid, extra.geometry, extra.mechanics)
      : undefined;
  return {
    ...(extra.name !== undefined ? { name: extra.name } : {}),
    line,
    grid,
    ...(extra.geometry ? { geometry: extra.geometry } : {}),
    metrics,
    shape: classifyMeshShape(grid, { flatTolerance: flatness.excellent }),
    grade: gradeFlatness(metrics.range, flatness),
    ...(interpolated ? { interpolated } : {}),
    ...(screws ? { screws } : {}),
  };
}

function diagnoseMesh(
  analysis: MeshAnalysis,
  index: number,
  options: BedMeshOptions,
): Diagnostic[] {
  const { metrics, shape } = analysis;
  const diagnostics: Diagnostic[] = [];
  const range = round3(metrics.range);
  if (analysis.grade === "poor") {
    diagnostics.push({
      code: "bedMesh.rangeLarge",
      severity: "warning",
      mesh: index,
      params: { range },
    });
  } else if (analysis.grade === "fair") {
    diagnostics.push({
      code: "bedMesh.rangeModerate",
      severity: "info",
      mesh: index,
      params: { range },
    });
  }

  // Inclinaison → vis : réglage concret quand l'assistant de vis est disponible.
  const toAdjust = (analysis.screws?.adjustments ?? []).filter(
    (screw) => !screw.base && screw.turns * 60 + screw.minutes >= SCREWS_DONE_MINUTES,
  );
  if (toAdjust.length > 0) {
    diagnostics.push({
      code: "bedMesh.screwsAdjust",
      severity: "info",
      mesh: index,
      params: {
        count: toAdjust.length,
        maxMinutes: Math.max(...toAdjust.map((screw) => screw.turns * 60 + screw.minutes)),
      },
    });
  }

  // Conseil sur la forme dominante, avec l'amplitude de la composante (mm).
  const byShape = {
    flat: "bedMesh.flat",
    tilted: "bedMesh.tilted",
    bowl: "bedMesh.bowl",
    dome: "bedMesh.dome",
    saddle: "bedMesh.saddle",
    twisted: "bedMesh.twisted",
    irregular: "bedMesh.irregular",
  } as const;
  const params: Record<string, string | number> = {
    confidence: Math.round(shape.confidence * 100),
    tilt: round3(shape.components.tilt),
    curvature: round3(shape.components.curvature),
    twist: round3(shape.components.twist),
  };
  if (shape.shape === "tilted") {
    params["riseX"] = round3(metrics.plane.riseX);
    params["riseY"] = round3(metrics.plane.riseY);
  }
  if (shape.shape === "twisted" && shape.highDiagonal) params["highDiagonal"] = shape.highDiagonal;
  if (shape.curvatureAxis) params["curvatureAxis"] = shape.curvatureAxis;

  // Bruit → sonde : écart RÉPARTI sur tout le plateau que la forme n'explique pas (aucun point
  // ne domine). Un pic isolé, lui, reste un défaut localisé (débris, aimant : « irrégulier »).
  const { residualRms, residualPeak } = shape.components;
  const noisy =
    metrics.count >= NOISE_MIN_POINTS &&
    residualRms >= (options.noise ?? DEFAULT_NOISE_THRESHOLD) &&
    residualPeak < NOISE_PEAK_RATIO * residualRms;
  if (!(noisy && shape.shape === "irregular")) {
    diagnostics.push({ code: byShape[shape.shape], severity: "info", mesh: index, params });
  }
  if (noisy) {
    diagnostics.push({
      code: "bedMesh.noisy",
      severity: "info",
      mesh: index,
      params: { rms: round3(residualRms) },
    });
  }
  return diagnostics;
}

/** Réglages de [bed_mesh] que Klipper refuse au démarrage (erreur de configuration). */
const INVALID_MESH_CONFIG = new Set<ProbeAreaCode>([
  "probeArea.invalidMinMax",
  "probeArea.tooClose",
  "probeArea.roundCountEven",
  "probeArea.countTooLow",
]);

function diagnoseProbeArea(result: ParseResult<ProbeArea, ProbeAreaCode>): Diagnostic[] {
  if (!result.ok && result.error.code === "probeArea.countTooHigh") {
    // Klipper l'accepterait, mais Zipero ne génère pas autant de points (EP-16.02).
    return [
      {
        code: "bedMesh.probeCountTooHigh",
        severity: "warning",
        params: { max: ANALYSIS_LIMITS.maxProbePoints },
      },
    ];
  }
  if (!result.ok) {
    return INVALID_MESH_CONFIG.has(result.error.code)
      ? [
          {
            code: "bedMesh.meshConfigInvalid",
            severity: "critical",
            params: { reason: result.error.code },
          },
        ]
      : [];
  }
  return result.value.problems.map((problem) => ({
    code: "bedMesh.probeAreaOutOfRange" as const,
    severity: "critical" as const,
    params: { ...problem.params, shape: result.value.shape },
  }));
}

/** Une configuration Klipper se reconnaît à ses en-têtes de section usuels. */
const CONFIG_HEADER =
  /^(?:#\*# )?\[(?:bed_mesh|printer|stepper_[a-z]|mcu|probe|bltouch|extruder)\b/m;
const PROBE_ACCURACY = /probe accuracy results|probe at -?[\d.]+,-?[\d.]+ is z=/i;
const MESH_OUTPUT = /Mesh Leveling Probed Z positions/i;

function analyzeProbeAccuracy(text: string): ParseResult<BedMeshReport, string> {
  const parsed = parseProbeAccuracy(text);
  if (!parsed.ok) return failure(parsed.error, parsed.warnings);
  const probeAccuracy = parsed.value.map((run) => ({
    ...run,
    assessment: assessRepeatability(run),
  }));
  const verdictCode = {
    good: "bedMesh.probeGood",
    borderline: "bedMesh.probeBorderline",
    insufficient: "bedMesh.probeInsufficient",
  } as const;
  const verdictSeverity = {
    good: "info",
    borderline: "warning",
    insufficient: "critical",
  } as const;
  const diagnostics = probeAccuracy.map(
    (run, index): Diagnostic => ({
      code: verdictCode[run.assessment.verdict],
      severity: verdictSeverity[run.assessment.verdict],
      mesh: index,
      params: {
        range: Math.round(run.stats.range * 100_000) / 100_000,
        samples: run.samples.length,
        lowSampleCount: run.assessment.lowSampleCount ? 1 : 0,
      },
    }),
  );
  return success(
    {
      input: "probe-accuracy",
      meshes: [],
      probeAccuracy,
      diagnostics: sortDiagnostics(diagnostics),
    },
    parsed.warnings,
  );
}

export function analyzeBedMesh(
  text: string,
  options: BedMeshOptions = {},
): ParseResult<BedMeshReport, string> {
  if (CONFIG_HEADER.test(text)) {
    const profiles = parseMeshProfiles(text);
    const mechanics = extractPrinterMechanics(parseConfig(text));
    const probeArea = checkProbeArea(mechanics);
    const meshes = profiles.ok
      ? profiles.value.map((profile) =>
          analyzeMesh(profile.probed, profile.line, options, {
            name: profile.name,
            geometry: profile.params,
            interpolation: {
              xPps: profile.params.xPps,
              yPps: profile.params.yPps,
              algorithm: profile.params.algorithm,
              tension: profile.params.tension,
            },
            mechanics,
          }),
        )
      : [];
    const diagnostics = [
      ...diagnoseProbeArea(probeArea),
      ...meshes.flatMap((mesh, index) => diagnoseMesh(mesh, index, options)),
    ];
    // Rien d'exploitable : ni profil, ni zone sondée contrôlable, ni erreur de [bed_mesh].
    if (!profiles.ok && !probeArea.ok && diagnostics.length === 0) {
      return failure(profiles.error, profiles.warnings);
    }
    return success(
      { input: "config", meshes, probeArea, mechanics, diagnostics: sortDiagnostics(diagnostics) },
      profiles.warnings,
    );
  }

  if (PROBE_ACCURACY.test(text) && !MESH_OUTPUT.test(text)) return analyzeProbeAccuracy(text);

  const parsed = parseBedMeshOutput(text);
  if (!parsed.ok) return failure(parsed.error, parsed.warnings);
  const meshes = parsed.value.map((mesh) =>
    analyzeMesh(mesh.probed, mesh.line, options, {
      ...(mesh.interpolated
        ? {
            printed: {
              grid: mesh.interpolated,
              ...(mesh.reported?.algorithm ? { algorithm: mesh.reported.algorithm } : {}),
            },
          }
        : {}),
    }),
  );
  return success(
    {
      input: "console",
      meshes,
      diagnostics: sortDiagnostics(
        meshes.flatMap((mesh, index) => diagnoseMesh(mesh, index, options)),
      ),
    },
    parsed.warnings,
  );
}

/** Tri stable par sévérité (bloquant, important, conseil), puis par maillage. */
function sortDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return diagnostics.toSorted(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (a.mesh ?? -1) - (b.mesh ?? -1),
  );
}
