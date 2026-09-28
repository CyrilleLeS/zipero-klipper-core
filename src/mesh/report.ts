// SPDX-License-Identifier: GPL-3.0-only
import { parseConfig } from "../config/ini";
import { extractPrinterMechanics, type PrinterMechanics } from "../printers/extract";
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
import { classifyMeshShape, type ShapeClassification } from "./shape";
import type { MeshGeometry, MeshGrid } from "./types";

/**
 * Rapport de l'outil Bed mesh (EP-05, EP-03.08) : une seule entrée, deux formats reconnus.
 * - Configuration (`printer.cfg`, avec ou sans bloc SAVE_CONFIG) : profils sauvegardés et
 *   contrôle de la zone sondée (EP-05.13).
 * - Sortie console de BED_MESH_OUTPUT : maillage(s) affiché(s).
 * Chaque maillage reçoit ses métriques (EP-05.07) et sa forme (EP-05.08) ; les diagnostics sont
 * des codes triés par sévérité, traduits par l'interface (le cœur ne produit aucun texte).
 */

export type Severity = "critical" | "warning" | "info";

/** Tous les codes possibles (l'interface vérifie qu'ils sont tous traduits). */
export const BED_MESH_DIAGNOSTIC_CODES = [
  "bedMesh.probeAreaOutOfRange",
  "bedMesh.meshConfigInvalid",
  "bedMesh.rangeLarge",
  "bedMesh.rangeModerate",
  "bedMesh.tilted",
  "bedMesh.bowl",
  "bedMesh.dome",
  "bedMesh.saddle",
  "bedMesh.twisted",
  "bedMesh.irregular",
  "bedMesh.flat",
] as const;

export type BedMeshDiagnosticCode = (typeof BED_MESH_DIAGNOSTIC_CODES)[number];

export interface Diagnostic extends Issue<BedMeshDiagnosticCode> {
  readonly severity: Severity;
  /** Index du maillage concerné dans `meshes` (absent : concerne la configuration). */
  readonly mesh?: number;
}

export type FlatnessGrade = "excellent" | "good" | "fair" | "poor";

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
}

export interface BedMeshReport {
  readonly input: "console" | "config";
  readonly meshes: readonly MeshAnalysis[];
  /** Contrôle de la zone sondée (configuration uniquement) : résultat ou raison de l'absence. */
  readonly probeArea?: ParseResult<ProbeArea, ProbeAreaCode>;
  readonly mechanics?: PrinterMechanics;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Seuils d'amplitude (mm, crête à crête) pour la note de planéité. Repères d'usage courant pour
 * un plateau compensé par maillage : jusqu'à 0,1 mm la première couche est uniforme ; au-delà de
 * 0,5 mm la compensation ne rattrape plus l'écrasement de la première couche partout. À affiner
 * avec les retours de la bêta (EP-19).
 */
export const FLATNESS_THRESHOLDS = { excellent: 0.1, good: 0.2, fair: 0.5 } as const;

export function gradeFlatness(range: number): FlatnessGrade {
  if (range <= FLATNESS_THRESHOLDS.excellent) return "excellent";
  if (range <= FLATNESS_THRESHOLDS.good) return "good";
  if (range <= FLATNESS_THRESHOLDS.fair) return "fair";
  return "poor";
}

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
const round3 = (value: number) => Math.round(value * 1000) / 1000;

function analyzeMesh(
  grid: MeshGrid,
  line: number,
  extra: {
    name?: string;
    geometry?: MeshGeometry;
    interpolation?: InterpolationParams;
    printed?: { grid: MeshGrid; algorithm?: string };
  },
): MeshAnalysis {
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
  return {
    ...(extra.name !== undefined ? { name: extra.name } : {}),
    line,
    grid,
    ...(extra.geometry ? { geometry: extra.geometry } : {}),
    metrics,
    shape: classifyMeshShape(grid),
    grade: gradeFlatness(metrics.range),
    ...(interpolated ? { interpolated } : {}),
  };
}

function diagnoseMesh(analysis: MeshAnalysis, index: number): Diagnostic[] {
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
  // Conseil sur la forme dominante, avec l'amplitude de la composante (mm).
  const shapeParams = {
    confidence: Math.round(shape.confidence * 100),
    tilt: round3(shape.components.tilt),
    curvature: round3(shape.components.curvature),
    twist: round3(shape.components.twist),
  };
  const byShape = {
    flat: "bedMesh.flat",
    tilted: "bedMesh.tilted",
    bowl: "bedMesh.bowl",
    dome: "bedMesh.dome",
    saddle: "bedMesh.saddle",
    twisted: "bedMesh.twisted",
    irregular: "bedMesh.irregular",
  } as const;
  const params: Record<string, string | number> = { ...shapeParams };
  if (shape.shape === "tilted") {
    params["riseX"] = round3(metrics.plane.riseX);
    params["riseY"] = round3(metrics.plane.riseY);
  }
  if (shape.shape === "twisted" && shape.highDiagonal) params["highDiagonal"] = shape.highDiagonal;
  if (shape.curvatureAxis) params["curvatureAxis"] = shape.curvatureAxis;
  diagnostics.push({ code: byShape[shape.shape], severity: "info", mesh: index, params });
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

export function analyzeBedMesh(text: string): ParseResult<BedMeshReport, string> {
  if (CONFIG_HEADER.test(text)) {
    const profiles = parseMeshProfiles(text);
    const mechanics = extractPrinterMechanics(parseConfig(text));
    const probeArea = checkProbeArea(mechanics);
    const meshes = profiles.ok
      ? profiles.value.map((profile) =>
          analyzeMesh(profile.probed, profile.line, {
            name: profile.name,
            geometry: profile.params,
            interpolation: {
              xPps: profile.params.xPps,
              yPps: profile.params.yPps,
              algorithm: profile.params.algorithm,
              tension: profile.params.tension,
            },
          }),
        )
      : [];
    const diagnostics = [...diagnoseProbeArea(probeArea), ...meshes.flatMap(diagnoseMesh)];
    // Rien d'exploitable : ni profil, ni zone sondée contrôlable, ni erreur de [bed_mesh].
    if (!profiles.ok && !probeArea.ok && diagnostics.length === 0) {
      return failure(profiles.error, profiles.warnings);
    }
    return success(
      {
        input: "config",
        meshes,
        probeArea,
        mechanics,
        diagnostics: sortDiagnostics(diagnostics),
      },
      profiles.warnings,
    );
  }

  const parsed = parseBedMeshOutput(text);
  if (!parsed.ok) return failure(parsed.error, parsed.warnings);
  const meshes = parsed.value.map((mesh) =>
    analyzeMesh(mesh.probed, mesh.line, {
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
    { input: "console", meshes, diagnostics: sortDiagnostics(meshes.flatMap(diagnoseMesh)) },
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
