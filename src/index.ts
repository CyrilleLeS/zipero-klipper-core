// SPDX-License-Identifier: GPL-3.0-only
// API publique du cœur d'analyse. Les résultats portent des codes (traduits par l'interface).

export { type ConfigOption, type ConfigSection, parseConfig } from "./config/ini";
export {
  type ConsoleMesh,
  MESH_CONSOLE_CODES,
  type MeshConsoleCode,
  parseBedMeshOutput,
  type ReportedMeshInfo,
} from "./mesh/console";
export {
  computeMeshMetrics,
  type GridPoint,
  type MeshMetrics,
  type PlaneFit,
} from "./mesh/metrics";
export {
  type Bounds,
  checkProbeArea,
  PROBE_AREA_CODES,
  type ProbeArea,
  type ProbeAreaCode,
  type ProbePoint,
} from "./mesh/probe-area";
export {
  MESH_PROFILE_CODES,
  type MeshProfile,
  type MeshProfileCode,
  parseMeshProfiles,
} from "./mesh/profiles";
export {
  analyzeBedMesh,
  BED_MESH_DIAGNOSTIC_CODES,
  type BedMeshDiagnosticCode,
  type BedMeshReport,
  type Diagnostic,
  FLATNESS_THRESHOLDS,
  type FlatnessGrade,
  gradeFlatness,
  type MeshAnalysis,
  type Severity,
} from "./mesh/report";
export {
  classifyMeshShape,
  DEFAULT_FLAT_TOLERANCE,
  type MeshShape,
  type ShapeClassification,
  type ShapeComponents,
  type ShapeOptions,
} from "./mesh/shape";
export type { MeshGeometry, MeshGrid, MeshProfileParams } from "./mesh/types";
export { toGrid } from "./mesh/types";
export {
  extractPrinterMechanics,
  type MeshSettings,
  type PrinterMechanics,
  type ProbeInfo,
  type ScrewPoint,
  type ScrewsInfo,
  type Travel,
} from "./printers/extract";
export {
  findReferencePrinter,
  REFERENCE_PRINTERS,
  type ReferencePrinter,
} from "./printers/reference";
export {
  assessRepeatability,
  computeProbeStats,
  DEFAULT_REPEATABILITY_THRESHOLDS,
  type ProbeAccuracyCode,
  type ProbeAccuracyRun,
  type ProbeStats,
  parseProbeAccuracy,
  type RepeatabilityAssessment,
  type RepeatabilityThresholds,
  type RepeatabilityVerdict,
} from "./probe/accuracy";
export { failure, type Issue, type ParseResult, success } from "./result";
export { type ConsoleLine, cleanConsoleLine, consoleLines, parseNumberRow } from "./text/console";
export { type SourceLine, splitLines } from "./text/lines";
