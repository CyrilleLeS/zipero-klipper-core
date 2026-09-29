// SPDX-License-Identifier: GPL-3.0-only
// Lint des modèles Jinja d'une configuration (EP-06.07) : chaque option compilée par Klipper au
// démarrage (`load_template`), avec l'environnement Jinja du firmware, erreurs ramenées à la ligne
// du fichier.

import type { FirmwareId } from "../config/firmwares";
import type { ConfigOption, ConfigSection } from "../config/ini";
import type { ConfigSchema } from "../config/validate";
import { type JinjaIssue, jinjaEnvironment, lintTemplate } from "./jinja";

/**
 * Options lues par des boucles sur préfixes ou des menus, que l'analyse du code ne suit pas :
 * relevées dans extras/display/display.py et extras/display/menu.py de chaque firmware.
 */
const DYNAMIC_TEMPLATES: readonly {
  readonly section: RegExp;
  readonly options: readonly string[];
  readonly firmwares?: readonly FirmwareId[];
}[] = [
  { section: /^(?:display_template|display_data) .+$/, options: ["text"] },
  { section: /^menu .+$/, options: ["name", "enable", "input", "input_min", "input_max", "gcode"] },
  {
    section: /^menu .+$/,
    options: ["title", "suffix", "cancel_text", "confirm_text"],
    firmwares: ["kalico"],
  },
];

const compiled = new WeakMap<ConfigSchema, readonly [RegExp, readonly string[]][]>();

/** Options de la section compilées comme modèles par ce firmware. */
export function templateOptions(
  schema: ConfigSchema,
  firmware: FirmwareId,
  section: string,
): Set<string> {
  let rules = compiled.get(schema);
  if (!rules) {
    rules = schema.rules.map((rule) => [
      new RegExp(rule.regex),
      Object.entries(rule.options)
        .filter(([, option]) => option.template)
        .map(([name]) => name),
    ]);
    compiled.set(schema, rules);
  }
  const names = new Set<string>();
  for (const [pattern, options] of rules) {
    if (pattern.test(section)) for (const name of options) names.add(name);
  }
  for (const entry of DYNAMIC_TEMPLATES) {
    if (entry.section.test(section) && (!entry.firmwares || entry.firmwares.includes(firmware))) {
      for (const name of entry.options) names.add(name);
    }
  }
  return names;
}

const PY_SPACE =
  "[\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
const LEADING = new RegExp(`^${PY_SPACE}+`, "u");
const TRAILING = new RegExp(`${PY_SPACE}+$`, "u");

/**
 * Texte réellement compilé. Kalico (`getscript`) retire les blancs autour de la valeur et exécute
 * en Python une valeur commençant par `!`, ou le fichier désigné par `!!include` : pas de Jinja.
 * `offset` : lignes retirées en tête (pour retrouver la ligne du fichier).
 */
export function templateSource(
  firmware: FirmwareId,
  value: string,
): { readonly source: string; readonly offset: number } | undefined {
  if (firmware !== "kalico") return { source: value, offset: 0 };
  const leading = LEADING.exec(value)?.[0] ?? "";
  const source = value.slice(leading.length).replace(TRAILING, "");
  if (source.startsWith("!") || /!!include /.test(source)) return undefined;
  return { source, offset: leading.split("\n").length - 1 };
}

export interface MacroIssue extends JinjaIssue {
  readonly section: string;
  readonly option: string;
  readonly file: string;
  /** Ligne du fichier (celle de l'option si la ligne du modèle est inconnue). */
  readonly fileLine: number;
}

export interface MacroTemplate {
  readonly section: string;
  readonly option: ConfigOption;
  /** Texte compilé par Jinja. */
  readonly source: string;
  /** Lignes retirées en tête de la valeur (Kalico). */
  readonly offset: number;
}

/** Modèles Jinja que le firmware compilera au démarrage, dans l'ordre de la configuration. */
export function macroTemplates(
  sections: readonly ConfigSection[],
  schema: ConfigSchema,
  firmware: FirmwareId,
): MacroTemplate[] {
  const templates: MacroTemplate[] = [];
  for (const section of sections) {
    const names = templateOptions(schema, firmware, section.name);
    if (names.size === 0) continue;
    for (const option of section.options.values()) {
      const script = names.has(option.name) ? templateSource(firmware, option.value) : undefined;
      if (script) templates.push({ section: section.name, option, ...script });
    }
  }
  return templates;
}

/** Ligne du fichier d'une ligne du modèle (celle de l'option si elle est inconnue). */
export const fileLineOf = (template: MacroTemplate, line: number) =>
  template.option.valueLines[line - 1 + template.offset] ?? template.option.line;

/** Vérifie tous les modèles de la configuration, pour le firmware donné. */
export function lintMacros(
  sections: readonly ConfigSection[],
  schema: ConfigSchema,
  firmware: FirmwareId,
): MacroIssue[] {
  const env = jinjaEnvironment(firmware);
  return macroTemplates(sections, schema, firmware).flatMap(({ section, option, source, offset }) =>
    lintTemplate(source, env).map((issue) => ({
      ...issue,
      section,
      option: option.name,
      file: option.file,
      fileLine: option.valueLines[issue.line - 1 + offset] ?? option.line,
    })),
  );
}
