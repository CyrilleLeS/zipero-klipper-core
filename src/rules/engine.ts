// SPDX-License-Identifier: GPL-3.0-only
import type { ConfigOption, ConfigSection } from "../config/ini";
import { pyFloat, pyStrip } from "../config/values";

/**
 * Moteur de règles de diagnostic (EP-01.09, ADR 0025). Les règles sont des DONNÉES (JSON
 * versionné, distribuable sans redéployer l'application) ; ce moteur les interprète sans jamais
 * exécuter de code (CSP stricte, ADR 0020) : un petit langage déclaratif de conditions.
 *
 * Valeurs : `{ "option": "x" }` (section évaluée), `{ "section": "stepper_x", "option": "x" }`,
 * `index` pour un élément de liste (`home_xy_position`), `default` si l'option est absente ;
 * `{ "number": 5 }`, `{ "text": "…" }`.
 * Conditions : `all`, `any`, `not`, `exists`, `missing`, `eq`, `ne`, `lt`, `le`, `gt`, `ge`
 * (nombres convertis comme `float()` de Python), `matches` (expression régulière),
 * `sectionExists` (nom de section, expression régulière).
 */

export const RULES_FORMAT = 1;

export type RuleValue =
  | {
      readonly option: string;
      readonly section?: string;
      readonly index?: number;
      readonly default?: number | string;
    }
  | { readonly number: number }
  | { readonly text: string };

export type RuleCondition =
  | { readonly all: readonly RuleCondition[] }
  | { readonly any: readonly RuleCondition[] }
  | { readonly not: RuleCondition }
  | { readonly exists: RuleValue }
  | { readonly missing: RuleValue }
  | { readonly eq: readonly [RuleValue, RuleValue] }
  | { readonly ne: readonly [RuleValue, RuleValue] }
  | { readonly lt: readonly [RuleValue, RuleValue] }
  | { readonly le: readonly [RuleValue, RuleValue] }
  | { readonly gt: readonly [RuleValue, RuleValue] }
  | { readonly ge: readonly [RuleValue, RuleValue] }
  | { readonly matches: readonly [RuleValue, string] }
  | { readonly sectionExists: string };

export interface RuleTexts {
  readonly title: string;
  readonly detail: string;
}

export interface RuleDefinition {
  readonly id: string;
  readonly severity: "error" | "warning" | "info";
  /** Sections évaluées (expression régulière sur le nom) ; la règle est testée pour chacune. */
  readonly sections: string;
  readonly when: RuleCondition;
  /** Option où placer le diagnostic (sa ligne), sinon l'en-tête de la section. */
  readonly at?: string;
  /** Valeurs insérées dans les textes (`{nom}`). */
  readonly params?: Readonly<Record<string, RuleValue>>;
  /** Textes par langue ; `fr` obligatoire. */
  readonly texts: Readonly<Record<string, RuleTexts>>;
  /** Produits liés (EP-11, affiliation) : identifiants du catalogue. */
  readonly products?: readonly string[];
  /**
   * Règle fondée sur une ABSENCE (section ou option manquante) : sautée quand un fichier inclus
   * manque, car ce qui manque y est peut-être (ADR 0022, configuration partielle).
   */
  readonly complete?: boolean;
  /** Source du fait vérifié (code ou documentation de Klipper, fichier et ligne). */
  readonly source: string;
}

export interface RuleBundle {
  readonly format: number;
  readonly version: string;
  readonly rules: readonly RuleDefinition[];
}

export interface RuleHit {
  readonly id: string;
  readonly severity: RuleDefinition["severity"];
  readonly file: string;
  readonly line: number;
  readonly section: string;
  readonly params: Readonly<Record<string, string | number>>;
}

type Scalar = string | number | undefined;

interface Context {
  readonly section: ConfigSection;
  readonly byName: ReadonlyMap<string, ConfigSection>;
}

const regexCache = new Map<string, RegExp>();
const regex = (source: string) => {
  let compiled = regexCache.get(source);
  if (!compiled) {
    compiled = new RegExp(source);
    regexCache.set(source, compiled);
  }
  return compiled;
};

function optionOf(
  value: Extract<RuleValue, { option: string }>,
  ctx: Context,
): ConfigOption | undefined {
  const section = value.section === undefined ? ctx.section : ctx.byName.get(value.section);
  return section?.options.get(value.option);
}

function resolve(value: RuleValue, ctx: Context): Scalar {
  if ("number" in value) return value.number;
  if ("text" in value) return value.text;
  // Section désignée absente (imprimante delta sans [stepper_x]) : pas de valeur, même par défaut.
  if (value.section !== undefined && !ctx.byName.has(value.section)) return undefined;
  const option = optionOf(value, ctx);
  if (!option) return value.default;
  if (value.index === undefined) return pyStrip(option.value);
  return pyStrip(option.value.split(",")[value.index] ?? "") || undefined;
}

const asNumber = (value: Scalar) =>
  typeof value === "number" ? value : value === undefined ? undefined : pyFloat(value);

function compare(
  pair: readonly [RuleValue, RuleValue],
  ctx: Context,
  test: (a: number, b: number) => boolean,
) {
  const a = asNumber(resolve(pair[0], ctx));
  const b = asNumber(resolve(pair[1], ctx));
  // Valeur absente ou illisible : la règle ne conclut pas (le validateur la signale déjà).
  return a !== undefined && b !== undefined && !Number.isNaN(a) && !Number.isNaN(b) && test(a, b);
}

export function evaluate(condition: RuleCondition, ctx: Context): boolean {
  if ("all" in condition) return condition.all.every((c) => evaluate(c, ctx));
  if ("any" in condition) return condition.any.some((c) => evaluate(c, ctx));
  if ("not" in condition) return !evaluate(condition.not, ctx);
  if ("exists" in condition) return resolve(condition.exists, ctx) !== undefined;
  if ("missing" in condition) return resolve(condition.missing, ctx) === undefined;
  if ("eq" in condition)
    return String(resolve(condition.eq[0], ctx)) === String(resolve(condition.eq[1], ctx));
  if ("ne" in condition)
    return String(resolve(condition.ne[0], ctx)) !== String(resolve(condition.ne[1], ctx));
  if ("lt" in condition) return compare(condition.lt, ctx, (a, b) => a < b);
  if ("le" in condition) return compare(condition.le, ctx, (a, b) => a <= b);
  if ("gt" in condition) return compare(condition.gt, ctx, (a, b) => a > b);
  if ("ge" in condition) return compare(condition.ge, ctx, (a, b) => a >= b);
  if ("matches" in condition) {
    const value = resolve(condition.matches[0], ctx);
    return value !== undefined && regex(condition.matches[1]).test(String(value));
  }
  if ("sectionExists" in condition) {
    const pattern = regex(condition.sectionExists);
    return [...ctx.byName.keys()].some((name) => pattern.test(name));
  }
  throw new Error(`Condition inconnue : ${JSON.stringify(condition)}`);
}

/** Applique toutes les règles à une configuration résolue (`readConfig`). */
export function evaluateRules(
  sections: readonly ConfigSection[],
  bundle: RuleBundle,
  options: { readonly partial?: boolean } = {},
): RuleHit[] {
  if (bundle.format !== RULES_FORMAT) return [];
  const byName = new Map(sections.map((s) => [s.name, s]));
  const hits: RuleHit[] = [];
  for (const rule of bundle.rules) {
    if (rule.complete && options.partial) continue;
    const scope = regex(rule.sections);
    for (const section of sections) {
      if (!scope.test(section.name)) continue;
      const ctx = { section, byName };
      if (!evaluate(rule.when, ctx)) continue;
      const at = rule.at ? section.options.get(rule.at) : undefined;
      const params: Record<string, string | number> = { section: section.name };
      for (const [name, value] of Object.entries(rule.params ?? {})) {
        const resolved = resolve(value, ctx);
        if (resolved !== undefined) params[name] = resolved;
      }
      hits.push({
        id: rule.id,
        severity: rule.severity,
        file: at?.file ?? section.file,
        line: at?.line ?? section.line,
        section: section.name,
        params,
      });
    }
  }
  return hits;
}

/** Texte d'une règle avec ses paramètres (`{nom}`) ; nombres au format de la langue. */
export function renderRuleText(
  template: string,
  params: Readonly<Record<string, string | number>>,
  locale: string,
): string {
  const numbers = new Intl.NumberFormat(locale, { maximumFractionDigits: 3 });
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    if (value === undefined) return whole;
    // Valeurs lues dans la configuration : citées telles qu'écrites ; nombres de la règle : formatés.
    return typeof value === "number" ? numbers.format(value) : value;
  });
}
