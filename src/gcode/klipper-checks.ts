// SPDX-License-Identifier: GPL-3.0-only
import { extendedParams, isTraditionalGcode, type MacroIndex } from "../macros/semantics";

/**
 * Règles Klipper d'un G-code (EP-04.10) : ce qui fera mal tourner l'impression sous Klipper, vu
 * depuis le G-code seul ou confronté à la configuration qui va l'exécuter.
 *
 * Faits vérifiés dans le code de Klipper :
 * - une commande inconnue reçoit « Unknown command » et la lecture continue (gcode.py,
 *   `cmd_default`) : sans `[gcode_arcs]`, les arcs G2/G3 sont sautés et la pièce est faussée ;
 * - `BED_MESH_CALIBRATE ADAPTIVE=1` sans `[exclude_object]`, ou sans objet défini au moment du
 *   palpage, palpe tout le plateau (bed_mesh.py, `set_adaptive_mesh`) ;
 * - les macros sont rendues avec le `Undefined` par défaut de Jinja (gcode_macro.py) : un
 *   paramètre attendu mais absent devient une valeur vide (0 après `|float`), sans erreur ;
 * - une extrusion sous `min_extrude_temp` est refusée et arrête l'impression (extruder.py).
 */

export interface GcodeCall {
  readonly command: string;
  readonly line: number;
  /** Ligne d'origine, tronquée à 300 caractères. */
  readonly raw: string;
}

export interface GcodeTemperature {
  readonly command: "M104" | "M109" | "M140" | "M190";
  readonly line: number;
  /** Consigne (S, sinon R) ; 0 si absente. */
  readonly target: number;
}

export interface GcodeFacts {
  readonly arcs: { readonly count: number; readonly firstLine: number };
  readonly excludeObject: {
    readonly defines: number;
    readonly firstDefineLine: number;
    readonly others: number;
  };
  /** Ligne de la première extrusion avec déplacement (G1/G2/G3 avec E positif et X ou Y). */
  readonly firstExtrusionLine: number | undefined;
  /** Première occurrence de chaque commande étendue (hors EXCLUDE_OBJECT_*), dans l'ordre. */
  readonly calls: readonly GcodeCall[];
  /** Commandes étendues avant la première extrusion, dans l'ordre (début du fichier). */
  readonly startCalls: readonly GcodeCall[];
  /** Consignes de température avant la première extrusion. */
  readonly startTemperatures: readonly GcodeTemperature[];
  /** Lignes BED_MESH_CALIBRATE du fichier. */
  readonly meshCalibrations: readonly GcodeCall[];
}

const MAX_CALLS = 500;
const MAX_START = 500;
const MAX_RAW = 300;

const SEMICOLON = 0x3b;
const NEWLINE = 0x0a;

/** Ligne en texte (ASCII ; tout autre octet devient « ? »), bornée. */
function lineText(bytes: Uint8Array, start: number, end: number): string {
  let text = "";
  for (let i = start; i < end && text.length < MAX_RAW; i++) {
    const byte = bytes[i] ?? 0;
    text += byte < 0x80 ? String.fromCharCode(byte) : "?";
  }
  return text.replace(/\r$/, "");
}

/** Valeur d'un paramètre traditionnel (`E1.5`, `S210`) dans une ligne sans commentaire. */
function letterValue(text: string, letter: string): number | undefined {
  const match = new RegExp(`(?:^|\\s)${letter}(-?\\d*\\.?\\d+)`, "i").exec(text);
  return match ? Number(match[1]) : undefined;
}

/**
 * Faits du G-code utiles aux règles, en un passage : les lignes de mouvement ne sont décodées que
 * jusqu'à la première extrusion (puis seulement leur commande), les commentaires jamais.
 */
export function readGcodeFacts(bytes: Uint8Array): GcodeFacts {
  let arcs = 0;
  let firstArc = 0;
  let defines = 0;
  let firstDefine = 0;
  let excludeOthers = 0;
  let firstExtrusion: number | undefined;
  const seen = new Set<string>();
  const calls: GcodeCall[] = [];
  const startCalls: GcodeCall[] = [];
  const startTemperatures: GcodeTemperature[] = [];
  const meshCalibrations: GcodeCall[] = [];

  let line = 0;
  let start = 0;
  const length = bytes.length;
  while (start < length) {
    let end = bytes.indexOf(NEWLINE, start);
    if (end < 0) end = length;
    line++;
    // Début de la ligne : blancs sautés.
    let i = start;
    while (i < end && (bytes[i] === 0x20 || bytes[i] === 0x09)) i++;
    const first = bytes[i] ?? SEMICOLON;
    if (i < end && first !== SEMICOLON) {
      const upper = first & 0xdf;
      const second = bytes[i + 1] ?? 0;
      const third = bytes[i + 2] ?? 0;
      const isMove =
        upper === 0x47 && (second === 0x30 || second === 0x31) && !(third >= 0x30 && third <= 0x39);
      const isArc =
        upper === 0x47 && (second === 0x32 || second === 0x33) && !(third >= 0x30 && third <= 0x39);
      if (isArc) {
        arcs++;
        if (firstArc === 0) firstArc = line;
      }
      if (isMove || isArc) {
        if (firstExtrusion === undefined) {
          const text = lineText(bytes, i, end).split(";")[0] ?? "";
          const e = letterValue(text, "E");
          if (e !== undefined && e > 0 && /(?:^|\s)[XY]-?[\d.]/i.test(text)) firstExtrusion = line;
        }
      } else {
        const raw = lineText(bytes, i, end);
        const text = (raw.split(";")[0] ?? "").trim();
        const command = text.split(/\s+/)[0]?.toUpperCase() ?? "";
        if (command) {
          const beforeExtrusion = firstExtrusion === undefined;
          if (/^M(104|109|140|190)$/.test(command) && beforeExtrusion) {
            if (startTemperatures.length < MAX_START) {
              startTemperatures.push({
                command: command as GcodeTemperature["command"],
                line,
                target: letterValue(text, "S") ?? letterValue(text, "R") ?? 0,
              });
            }
          } else if (!isTraditionalGcode(command)) {
            if (command === "EXCLUDE_OBJECT_DEFINE") {
              defines++;
              if (firstDefine === 0) firstDefine = line;
            } else if (command.startsWith("EXCLUDE_OBJECT")) {
              excludeOthers++;
            } else {
              const call = { command, line, raw: text };
              if (!seen.has(command) && calls.length < MAX_CALLS) {
                seen.add(command);
                calls.push(call);
              }
              if (beforeExtrusion && startCalls.length < MAX_START) startCalls.push(call);
              if (command === "BED_MESH_CALIBRATE" && meshCalibrations.length < 20) {
                meshCalibrations.push(call);
              }
            }
          }
        }
      }
    }
    start = end + 1;
  }
  return {
    arcs: { count: arcs, firstLine: firstArc },
    excludeObject: { defines, firstDefineLine: firstDefine, others: excludeOthers },
    firstExtrusionLine: firstExtrusion,
    calls,
    startCalls,
    startTemperatures,
    meshCalibrations,
  };
}

export const GCODE_CHECK_CODES = [
  "gcode.arcs-unsupported",
  "gcode.arcs-check",
  "gcode.exclude-object-unsupported",
  "gcode.adaptive-no-objects",
  "gcode.adaptive-before-objects",
  "gcode.unknown-command",
  "gcode.macro-param-unused",
  "gcode.macro-param-missing",
  "gcode.heat-order",
  "gcode.extrude-before-heat",
] as const;

export type GcodeCheckCode = (typeof GCODE_CHECK_CODES)[number];

export interface GcodeCheck {
  readonly code: GcodeCheckCode;
  readonly severity: "error" | "warning" | "info";
  readonly line?: number | undefined;
  readonly params?: Readonly<Record<string, string | number>>;
}

/** Configuration qui va exécuter le G-code (facultative). */
export interface GcodeConfigContext {
  /** Noms des sections (`gcode_arcs`, `exclude_object`, `gcode_macro PRINT_START`…). */
  readonly sections: ReadonlySet<string>;
  readonly macros: MacroIndex;
}

/** Commandes d'une macro et des macros qu'elle appelle (profondeur bornée). */
function macroCommands(
  context: GcodeConfigContext,
  name: string,
  depth = 0,
  visited = new Set<string>(),
): { command: string; raw: string }[] {
  if (depth > 4 || visited.has(name)) return [];
  visited.add(name);
  const usage = context.macros.macros.get(name);
  if (!usage) return [];
  return usage.commands.flatMap((entry) => [
    entry,
    ...(context.macros.macros.has(entry.command)
      ? macroCommands(context, entry.command, depth + 1, visited)
      : []),
  ]);
}

const isAdaptive = (raw: string) => extendedParams(raw, "BED_MESH_CALIBRATE")?.["ADAPTIVE"] === "1";

/** Chauffe de la buse avec attente : M109, ou TEMPERATURE_WAIT sur l'extrudeur. */
const waitsForNozzle = (entry: { command: string; raw: string }) =>
  entry.command === "M109" ||
  (entry.command === "TEMPERATURE_WAIT" &&
    /extruder/i.test(extendedParams(entry.raw, "TEMPERATURE_WAIT")?.["SENSOR"] ?? ""));

export function checkGcode(facts: GcodeFacts, context?: GcodeConfigContext): GcodeCheck[] {
  const checks: GcodeCheck[] = [];

  // Arcs : `[gcode_arcs]` requis.
  if (facts.arcs.count > 0) {
    if (context && !context.sections.has("gcode_arcs")) {
      checks.push({
        code: "gcode.arcs-unsupported",
        severity: "error",
        line: facts.arcs.firstLine,
        params: { count: facts.arcs.count },
      });
    } else if (!context) {
      checks.push({
        code: "gcode.arcs-check",
        severity: "info",
        line: facts.arcs.firstLine,
        params: { count: facts.arcs.count },
      });
    }
  }

  const excludeCount = facts.excludeObject.defines + facts.excludeObject.others;
  if (context && excludeCount > 0 && !context.sections.has("exclude_object")) {
    checks.push({
      code: "gcode.exclude-object-unsupported",
      severity: "warning",
      line: facts.excludeObject.firstDefineLine || undefined,
      params: { count: excludeCount },
    });
  }

  // Maillage adaptatif : demandé dans le G-code ou dans une macro appelée par le G-code.
  const adaptive =
    facts.meshCalibrations.find((call) => isAdaptive(call.raw))?.line ??
    (context
      ? facts.calls.find((call) =>
          macroCommands(context, call.command).some(
            (entry) => entry.command === "BED_MESH_CALIBRATE" && isAdaptive(entry.raw),
          ),
        )?.line
      : undefined);
  if (adaptive !== undefined && (!context || context.sections.has("exclude_object"))) {
    if (facts.excludeObject.defines === 0) {
      checks.push({ code: "gcode.adaptive-no-objects", severity: "warning", line: adaptive });
    } else if (facts.excludeObject.firstDefineLine > adaptive) {
      checks.push({
        code: "gcode.adaptive-before-objects",
        severity: "warning",
        line: adaptive,
        params: { defineLine: facts.excludeObject.firstDefineLine },
      });
    }
  }

  // Commandes et macros : inconnues de la configuration, paramètres incohérents.
  if (context) {
    for (const call of facts.calls) {
      const usage = context.macros.macros.get(call.command);
      if (!usage) {
        if (!context.macros.isCommand(call.command)) {
          checks.push({
            code: "gcode.unknown-command",
            severity: context.macros.foreign ? "info" : "warning",
            line: call.line,
            params: { command: call.command },
          });
        }
        continue;
      }
      if (usage.dynamic) continue;
      const passed = Object.keys(extendedParams(call.raw, call.command) ?? {});
      for (const param of passed) {
        if (!usage.read.has(param)) {
          checks.push({
            code: "gcode.macro-param-unused",
            severity: "warning",
            line: call.line,
            params: { macro: call.command, param, read: [...usage.read].join(", ") || "—" },
          });
        }
      }
      for (const param of usage.required) {
        if (!passed.includes(param)) {
          checks.push({
            code: "gcode.macro-param-missing",
            severity: "warning",
            line: call.line,
            params: { macro: call.command, param },
          });
        }
      }
    }
  }

  // Chauffes avant la première extrusion.
  const heating = facts.startTemperatures.filter((t) => t.target > 0);
  const nozzleWait = heating.find((t) => t.command === "M109");
  const bedWait = heating.find((t) => t.command === "M190");
  if (nozzleWait && bedWait && nozzleWait.line < bedWait.line) {
    checks.push({
      code: "gcode.heat-order",
      severity: "info",
      line: nozzleWait.line,
      params: { bedLine: bedWait.line },
    });
  }
  if (facts.firstExtrusionLine !== undefined && !nozzleWait) {
    // Une macro appelée avant peut chauffer : sans la configuration, on ne peut pas trancher.
    const macroHeats = facts.startCalls.some((call) =>
      context
        ? waitsForNozzle(call) || macroCommands(context, call.command).some(waitsForNozzle)
        : true,
    );
    if (!macroHeats) {
      checks.push({
        code: "gcode.extrude-before-heat",
        severity: "warning",
        line: facts.firstExtrusionLine,
      });
    }
  }

  return checks.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
}
