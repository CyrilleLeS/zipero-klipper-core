// SPDX-License-Identifier: GPL-3.0-only
// API publique du cœur d'analyse. Les résultats portent des codes (traduits par l'interface).

export {
  detectFirmware,
  FIRMWARES,
  type FirmwareCandidate,
  type FirmwareDetection,
  type FirmwareId,
  loadSchema,
} from "./config/firmwares";
export {
  CONFIG_READ_CODES,
  type ConfigInput,
  type ConfigOption,
  type ConfigProblem,
  type ConfigReadCode,
  type ConfigReadResult,
  type ConfigSection,
  parseConfig,
  readConfig,
} from "./config/ini";
export { normalizePath } from "./config/paths";
export { KLIPPER_SCHEMA } from "./config/schema";
export {
  COVERED_SECTIONS,
  type ConfigSchema,
  type SchemaCommands,
  type SchemaOption,
  type SchemaRule,
  VALIDATION_CODES,
  type ValidationCode,
  type ValidationIssue,
  validateConfig,
} from "./config/validate";
export {
  GCODE_SLICERS,
  type GcodeMetadata,
  type GcodeSlicer,
  type GcodeThumbnail,
  parseDuration,
  readGcodeMetadata,
} from "./gcode/metadata";
export {
  GCODE_LIMITS,
  type GcodeParseOptions,
  type GcodeStats,
  type GcodeToolpath,
  type GcodeWarningCode,
  parseGcode,
} from "./gcode/parse";
export { GCODE_ROLES, type GcodeRole, roleIndex } from "./gcode/roles";
export { ANALYSIS_LIMITS } from "./limits";
export {
  JINJA_CODES,
  JINJA_ENVIRONMENTS,
  type JinjaCode,
  type JinjaEnvironment,
  type JinjaIssue,
  jinjaEnvironment,
  lintTemplate,
} from "./macros/jinja";
export { checkMacroLiteral, type LiteralProblem } from "./macros/pyliteral";
export {
  checkMacros,
  isTraditionalGcode,
  klipperCommand,
  MACRO_CODES,
  type MacroCheckIssue,
  type MacroCheckOptions,
  type MacroCode,
} from "./macros/semantics";
export {
  lintMacros,
  type MacroIssue,
  type MacroTemplate,
  macroTemplates,
  templateOptions,
  templateSource,
} from "./macros/templates";
export {
  type ConsoleMesh,
  MESH_CONSOLE_CODES,
  type MeshConsoleCode,
  parseBedMeshOutput,
  type ReportedMeshInfo,
} from "./mesh/console";
export {
  DEFAULT_INTERPOLATION,
  effectiveAlgorithm,
  type Interpolation,
  type InterpolationCode,
  type InterpolationParams,
  interpolateMesh,
  type MeshAlgorithm,
} from "./mesh/interpolate";
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
  type BedMeshOptions,
  type BedMeshReport,
  computeMeshScrews,
  DEFAULT_NOISE_THRESHOLD,
  type Diagnostic,
  FLATNESS_THRESHOLDS,
  type FlatnessGrade,
  type FlatnessThresholds,
  gradeFlatness,
  type MeshAnalysis,
  type MeshScrews,
  type ProbeAccuracyAnalysis,
  SCREWS_DONE_MINUTES,
  type Severity,
} from "./mesh/report";
export {
  isScrewThread,
  type MeshSample,
  type ParsedScrewLine,
  parseScrewsTiltOutput,
  pythonRound,
  SCREW_THREADS,
  type ScrewAdjustment,
  type ScrewFromMesh,
  type ScrewReading,
  type ScrewThread,
  sampleMesh,
  screwReadingsFromMesh,
  screwsTiltAdjust,
  type TurnDirection,
} from "./mesh/screws";
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
export {
  evaluateRules,
  RULES_FORMAT,
  type RuleBundle,
  type RuleCondition,
  type RuleDefinition,
  type RuleHit,
  type RuleValue,
  renderRuleText,
} from "./rules/engine";
export { type ConsoleLine, cleanConsoleLine, consoleLines, parseNumberRow } from "./text/console";
export { type SourceLine, splitLines } from "./text/lines";
