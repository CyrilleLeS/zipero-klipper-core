// SPDX-License-Identifier: GPL-3.0-only
import type { Issue } from "../result";
import type { ConfigOption, ConfigSection } from "./ini";
import { type ListParser, pyBoolean, pyFloat, pyInt, pyLists } from "./values";

/**
 * Validation d'une configuration résolue (`readConfig`) contre le schéma généré depuis le code de
 * Klipper (EP-06.03, ADR 0022, scripts/schema). Pour chaque section : est-elle chargée par
 * Klipper ? quelles règles du schéma s'appliquent (cinématique de [printer], `sensor_type` et
 * `control` de la section) ? Puis, option par option, les contrôles que Klipper fait au démarrage :
 * conversion, bornes, choix, nombre d'éléments ; options supprimées (avec remplaçant), dépréciées,
 * inconnues (avertissement, ADR 0022 point 5), obligatoires absentes.
 */

export type OptionType =
  | "string"
  | "int"
  | "float"
  | "boolean"
  | "choice"
  | "list"
  | "int_list"
  | "float_list"
  | "lists"
  | "mixed";

export interface SchemaOption {
  readonly type?: OptionType;
  readonly required?: "always" | "conditional" | "never";
  readonly default?: unknown;
  readonly minval?: number;
  readonly maxval?: number;
  readonly above?: number;
  readonly below?: number;
  readonly choices?: readonly string[];
  readonly count?: number;
  readonly sep?: string;
  readonly seps?: readonly string[];
  readonly deprecated?: boolean;
  /** Lue par `load_template` : modèle Jinja compilé au démarrage (EP-06.07). */
  readonly template?: boolean;
  readonly sources: readonly string[];
}

export interface SchemaCondition {
  /** "self" : la section validée ; sinon le nom d'une section (ex. "printer"). */
  readonly section: string;
  readonly option: string;
  readonly values: readonly string[];
  /** Valeurs acceptées aussi : noms des sections « préfixe NOM » (capteurs personnalisés). */
  readonly sectionPrefix?: string;
}

export interface SchemaRule {
  readonly label: string;
  readonly regex: string;
  readonly when?: readonly SchemaCondition[];
  readonly options: Readonly<Record<string, SchemaOption>>;
  readonly patterns?: Readonly<Record<string, Partial<SchemaOption>>>;
}

/** Commandes G-code enregistrées par le firmware (EP-06.08), tirées de son code. */
export interface SchemaCommands {
  /** Toujours présentes (cœur de klippy et ce qu'il charge). */
  readonly always: readonly string[];
  /** Peut-être présentes (modules seulement importés par le cœur). */
  readonly alwaysPossible: readonly string[];
  /** Ajoutées à coup sûr par la section (préfixe) et ce que son module charge. */
  readonly sections: Readonly<Record<string, readonly string[]>>;
  /** Peut-être ajoutées (modules importés par celui de la section). */
  readonly possible: Readonly<Record<string, readonly string[]>>;
  /** Familles numérotées (`^T[0-9]+$`). */
  readonly patterns: Readonly<Record<string, readonly string[]>>;
}

export interface ConfigSchema {
  readonly firmware: string;
  readonly commit: string;
  /**
   * Kalico : références `${section.option}` dans les valeurs et section [constants] (noms libres,
   * une constante inutilisée n'est qu'un avertissement du firmware).
   */
  readonly interpolation?: boolean;
  /**
   * Sections dont une partie des lectures échappe à l'analyse (menus : options selon le type
   * d'élément) : aucune option n'y est dite inconnue.
   */
  readonly openSections?: readonly string[];
  readonly commands?: SchemaCommands;
  readonly kinematics: readonly string[];
  readonly sensorFamilies: readonly {
    readonly names: readonly string[];
    readonly sectionPrefix?: string;
  }[];
  readonly modules: { readonly exact: readonly string[]; readonly prefix: readonly string[] };
  readonly accessedSections: readonly string[];
  readonly rules: readonly SchemaRule[];
  readonly removed: readonly {
    readonly sectionRegex: string;
    readonly option: string;
    /** Famille d'options (`default_parameter_…`) ; sinon le nom exact `option`. */
    readonly optionRegex?: string;
    readonly since: string;
    readonly replacement: string | null;
  }[];
  /** Sections et options de forks ou de modules installés à part (couche curée). */
  readonly outsideKlipper: readonly {
    readonly origin: string;
    readonly sections?: readonly string[];
    readonly options?: readonly {
      readonly sectionRegex: string;
      readonly names: readonly string[];
    }[];
  }[];
}

/**
 * Sections dont les options inconnues et obligatoires absentes sont signalées : TOUTES depuis
 * EP-06.15, le schéma de chaque section de la référence ayant été confronté au vrai Klipper (et
 * à Kalico) en mode batch, cas par cas (tooling/corpus-tests, src/sections.test.ts). Seules les
 * sections dont le schéma est « indécidable » (variante inconnue) restent sans ces contrôles.
 * Au départ (EP-06.03) : printer, moteurs, extrudeurs, plateau, maillage, sonde, macros.
 */
export const COVERED_SECTIONS = [/./] as const;

export const VALIDATION_CODES = [
  "config.unknown-section",
  "config.unknown-option",
  "config.removed-option",
  "config.deprecated-option",
  "config.invalid-value",
  "config.out-of-range",
  "config.invalid-choice",
  "config.wrong-count",
  "config.missing-option",
  "config.not-in-klipper",
] as const;

export type ValidationCode = (typeof VALIDATION_CODES)[number];

export interface ValidationIssue extends Issue<ValidationCode> {
  /** error : Klipper refuserait de démarrer ; warning : à vérifier ; info : à savoir. */
  readonly severity: "error" | "warning" | "info";
  readonly file: string;
  readonly line: number;
  readonly section: string;
}

interface CompiledRule extends SchemaRule {
  readonly pattern: RegExp;
  readonly optionPatterns: readonly [RegExp, Partial<SchemaOption>][];
}

const compiled = new WeakMap<ConfigSchema, CompiledRule[]>();
function rulesOf(schema: ConfigSchema): CompiledRule[] {
  let rules = compiled.get(schema);
  if (!rules) {
    rules = schema.rules.map((rule) => ({
      ...rule,
      pattern: new RegExp(rule.regex),
      optionPatterns: Object.entries(rule.patterns ?? {}).map(
        ([regex, info]) => [new RegExp(`^${regex}$`), info] as [RegExp, Partial<SchemaOption>],
      ),
    }));
    compiled.set(schema, rules);
  }
  return rules;
}

/** Distance d'édition (suggestion pour une option mal orthographiée). */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j] ?? 0;
      row[j] = Math.min(
        current + 1,
        (row[j - 1] ?? 0) + 1,
        previous + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      previous = current;
    }
  }
  return row[b.length] ?? 0;
}

const LIST_PARSER: Partial<Record<OptionType, ListParser>> = {
  list: "string",
  int_list: "int",
  float_list: "float",
  lists: "string",
};

/** Contrôles de `_get_wrapper` sur une valeur présente ; undefined si elle est acceptée. */
function checkValue(
  option: ConfigOption,
  info: SchemaOption,
): { code: ValidationCode; params: Record<string, string | number> } | undefined {
  const params = { option: option.name, value: option.value };
  const type = info.type ?? "string";
  let number: number | undefined;
  if (type === "int" || type === "float") {
    number = type === "int" ? pyInt(option.value) : pyFloat(option.value);
    if (number === undefined)
      return { code: "config.invalid-value", params: { ...params, expected: type } };
  } else if (type === "boolean") {
    if (pyBoolean(option.value) === undefined) {
      return { code: "config.invalid-value", params: { ...params, expected: type } };
    }
  } else if (type === "choice" && info.choices) {
    if (!info.choices.includes(option.value)) {
      return {
        code: "config.invalid-choice",
        params: { ...params, choices: info.choices.join(", ") },
      };
    }
  } else if (type in LIST_PARSER) {
    const seps = info.seps ?? [info.sep ?? ","];
    const result = pyLists(option.value, seps, LIST_PARSER[type] ?? "string", info.count);
    if (!result.ok) {
      return result.reason === "count"
        ? { code: "config.wrong-count", params: { ...params, count: result.count ?? 0 } }
        : { code: "config.invalid-value", params: { ...params, expected: type } };
    }
  }
  if (number !== undefined) {
    // Comparaisons de Python (NaN n'est jamais hors bornes).
    if (info.minval !== undefined && number < info.minval) {
      return {
        code: "config.out-of-range",
        params: { ...params, bound: "minval", limit: info.minval },
      };
    }
    if (info.maxval !== undefined && number > info.maxval) {
      return {
        code: "config.out-of-range",
        params: { ...params, bound: "maxval", limit: info.maxval },
      };
    }
    if (info.above !== undefined && number <= info.above) {
      return {
        code: "config.out-of-range",
        params: { ...params, bound: "above", limit: info.above },
      };
    }
    if (info.below !== undefined && number >= info.below) {
      return {
        code: "config.out-of-range",
        params: { ...params, bound: "below", limit: info.below },
      };
    }
  }
  return undefined;
}

export interface ValidateOptions {
  /** Sections dont les options inconnues sont signalées (par défaut : COVERED_SECTIONS). */
  readonly covered?: readonly RegExp[];
  /** Configuration incomplète (fichier inclus absent) : pas d'alerte « option obligatoire ». */
  readonly partial?: boolean;
}

export function validateConfig(
  sections: readonly ConfigSection[],
  schema: ConfigSchema,
  options: ValidateOptions = {},
): ValidationIssue[] {
  const covered = options.covered ?? COVERED_SECTIONS;
  const rules = rulesOf(schema);
  const byName = new Map(sections.map((s) => [s.name, s]));
  const accessed = schema.accessedSections.map((regex) => new RegExp(regex));
  const open = (schema.openSections ?? []).map((regex) => new RegExp(regex));
  const removed = schema.removed.map((r) => ({
    ...r,
    pattern: new RegExp(r.sectionRegex),
    optionPattern: r.optionRegex ? new RegExp(r.optionRegex) : undefined,
  }));
  const optionValue = (section: string, option: string) =>
    byName.get(section)?.options.get(option)?.value;
  // Valeur d'un discriminant connue du firmware sans variante propre (`kinematics: winch`,
  // `sensor_type: a1333` n'ajoutent aucune option) : la section reste décidable (EP-06.15).
  const sensorNames = new Set(schema.sensorFamilies.flatMap((f) => f.names));
  const knownValue = (condition: SchemaCondition, value: string, sectionName: string) => {
    if (condition.option === "kinematics" && schema.kinematics.includes(value)) return true;
    if (condition.option === "sensor_type" && sensorNames.has(value)) return true;
    const owner = condition.section === "self" ? sectionName : condition.section;
    return rules.some(
      (rule) =>
        rule.pattern.test(owner) &&
        rule.options[condition.option]?.choices?.includes(value) === true,
    );
  };
  const issues: ValidationIssue[] = [];

  for (const section of sections) {
    const at = (option?: ConfigOption) => ({
      file: option?.file ?? section.file,
      line: option?.line ?? section.line,
      section: section.name,
    });

    // 1. Section chargée par Klipper (load_object ou lecture par un autre module) ?
    const parts = section.name.split(/\s+/);
    const module = parts[0] ?? "";
    // [constants] (Kalico) : noms libres, rien à vérifier.
    if (schema.interpolation && section.name === "constants") continue;
    const known =
      (parts.length === 1 && schema.modules.exact.includes(module)) ||
      (parts.length > 1 && schema.modules.prefix.includes(module)) ||
      accessed.some((pattern) => pattern.test(section.name));
    if (!known) {
      const outside = schema.outsideKlipper.find((o) => o.sections?.includes(module));
      if (outside) {
        // Fork ou module installé à part : normal chez qui l'a installé, jamais une erreur.
        issues.push({
          code: "config.not-in-klipper",
          severity: "info",
          ...at(),
          params: { section: section.name, origin: outside.origin },
        });
        continue;
      }
      // Proche d'un module connu : faute de frappe probable, que Klipper refuserait.
      const candidates = parts.length > 1 ? schema.modules.prefix : schema.modules.exact;
      const suggestion = candidates
        .map((name) => ({ name, d: distance(module, name) }))
        .filter(({ d }) => d > 0 && d <= 2)
        .sort((a, b) => a.d - b.d)[0]?.name;
      issues.push({
        code: "config.unknown-section",
        severity: suggestion ? "error" : "warning",
        ...at(),
        params: {
          section: section.name,
          ...(suggestion ? { suggestion: [suggestion, ...parts.slice(1)].join(" ") } : {}),
        },
      });
      continue;
    }

    // 2. Règles applicables ; « indécidable » si un discriminant a une valeur inconnue.
    let undecidable = false;
    const applicable = rules.filter((rule) => {
      if (!rule.pattern.test(section.name)) return false;
      return (rule.when ?? []).every((condition) => {
        const owner = condition.section === "self" ? section.name : condition.section;
        const value = optionValue(owner, condition.option);
        if (value === undefined) return false;
        return (
          condition.values.includes(value) ||
          (condition.sectionPrefix !== undefined &&
            byName.has(`${condition.sectionPrefix} ${value}`))
        );
      });
    });
    // Aucune règle pour ce nom : module qui ne lit aucune option ([exclude_object]…) ; toute
    // option y est refusée. Sinon (variantes sans correspondance, section lue ailleurs) : on ne
    // sait pas.
    const isModule =
      (parts.length === 1 && schema.modules.exact.includes(module)) ||
      (parts.length > 1 && schema.modules.prefix.includes(module));
    if (
      applicable.length === 0 &&
      (!isModule || rules.some((rule) => rule.pattern.test(section.name)))
    )
      continue;
    const knownOptions = new Map<string, SchemaOption>();
    for (const rule of applicable) {
      for (const [name, info] of Object.entries(rule.options)) {
        const existing = knownOptions.get(name);
        // Même option dans deux règles : première description gardée, obligation la plus forte.
        knownOptions.set(
          name,
          existing
            ? {
                ...existing,
                required: existing.required === "always" ? "always" : (info.required ?? "never"),
                sources: [...existing.sources, ...info.sources],
              }
            : info,
        );
      }
    }
    // Discriminants lus par une règle de variante dont aucune valeur ne correspond.
    for (const rule of rules) {
      if (!rule.pattern.test(section.name) || !rule.when) continue;
      for (const condition of rule.when) {
        const owner = condition.section === "self" ? section.name : condition.section;
        const value = optionValue(owner, condition.option);
        const matchedSomewhere = rules.some(
          (other) =>
            other.pattern.test(section.name) &&
            other.when?.some(
              (c) =>
                c.section === condition.section &&
                c.option === condition.option &&
                value !== undefined &&
                (c.values.includes(value) ||
                  (c.sectionPrefix !== undefined && byName.has(`${c.sectionPrefix} ${value}`))),
            ),
        );
        if (value !== undefined && !matchedSomewhere && !knownValue(condition, value, section.name))
          undecidable = true;
      }
    }
    const patterns = applicable.flatMap((rule) => rule.optionPatterns);
    const isCovered = covered.some((pattern) => pattern.test(section.name));
    // Section « ouverte » : options inconnues non signalées ; les obligatoires connues, si.
    const isOpen = open.some((pattern) => pattern.test(section.name));

    // 3. Options présentes.
    for (const option of section.options.values()) {
      const gone = removed.find(
        (r) =>
          (r.optionPattern ? r.optionPattern.test(option.name) : r.option === option.name) &&
          r.pattern.test(section.name),
      );
      const info =
        knownOptions.get(option.name) ?? patterns.find(([p]) => p.test(option.name))?.[1];
      const outside = !info
        ? schema.outsideKlipper.find((o) =>
            o.options?.some(
              (entry) =>
                entry.names.includes(option.name) &&
                new RegExp(entry.sectionRegex).test(section.name),
            ),
          )
        : undefined;
      if (outside) {
        issues.push({
          code: "config.not-in-klipper",
          severity: "info",
          ...at(option),
          params: { option: option.name, origin: outside.origin },
        });
        continue;
      }
      if (gone && !info) {
        issues.push({
          code: "config.removed-option",
          severity: "error",
          ...at(option),
          params: { option: option.name, since: gone.since, replacement: gone.replacement ?? "" },
        });
        continue;
      }
      if (!info) {
        if (isCovered && !isOpen && !undecidable) {
          const suggestion = [...knownOptions.keys()]
            .map((name) => ({ name, d: distance(option.name, name) }))
            .filter(({ d }) => d <= 2)
            .sort((a, b) => a.d - b.d)[0]?.name;
          issues.push({
            code: "config.unknown-option",
            severity: "warning",
            ...at(option),
            params: { option: option.name, ...(suggestion ? { suggestion } : {}) },
          });
        }
        continue;
      }
      if (info.deprecated) {
        issues.push({
          code: "config.deprecated-option",
          severity: "warning",
          ...at(option),
          params: { option: option.name },
        });
      }
      // Kalico : valeur construite par `${section.option}`, connue seulement du firmware.
      const interpolated = schema.interpolation && option.value.includes("${");
      if (info.type && info.type !== "mixed" && !interpolated) {
        const problem = checkValue(option, { sources: [], ...info });
        if (problem)
          issues.push({
            code: problem.code,
            severity: "error",
            ...at(option),
            params: problem.params,
          });
      }
    }

    // 4. Options obligatoires absentes (sections du parcours principal, cas décidables) ; jamais
    // sur une configuration partielle, dont un fichier inclus manque (ADR 0022).
    if (isCovered && !undecidable && !options.partial) {
      for (const [name, info] of knownOptions) {
        if (info.required === "always" && !section.options.has(name)) {
          issues.push({
            code: "config.missing-option",
            severity: "error",
            ...at(),
            params: { option: name },
          });
        }
      }
    }
  }
  return issues;
}
