// SPDX-License-Identifier: GPL-3.0-only
// API publique du cœur d'analyse. Les résultats portent des codes (traduits par l'interface).

export { type ConfigOption, type ConfigSection, parseConfig } from "./config/ini";
export {
  type ConsoleMesh,
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
export { type MeshProfile, type MeshProfileCode, parseMeshProfiles } from "./mesh/profiles";
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
