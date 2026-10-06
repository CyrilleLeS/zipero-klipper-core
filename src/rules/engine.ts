// SPDX-License-Identifier: GPL-3.0-only
import type { ConfigSection } from "../config/ini";
import { pyFloat, pyStrip } from "../config/values";
import type { LogSignature } from "../log/signatures";

/**
 * Moteur de règles de diagnostic (EP-01.09, ADR 0025). Les règles sont des DONNÉES (JSON
 * versionné, distribuable sans redéployer l'application) ; ce moteur les interprète sans jamais
 * exécuter de code (CSP stricte, ADR 0020) : un petit langage déclaratif de conditions.
 *
 * Valeurs : `{ "option": "x" }` (section évaluée), `{ "section": "stepper_x", "option": "x" }`,
 * `{ "sectionMatch": "^(probe|bltouch)$", "option": "x" }` (première section dont le nom correspond),
 * `index` pour un élément de liste (`home_xy_position`), `default` si l'option est absente ;
 * `{ "number": 5 }`, `{ "text": "…" }` ; calcul (format 2, EP-06.05) : `{ "sum": [a, b, …] }`,
 * `{ "difference": [a, b] }`, `{ "product": [a, b, …] }`, `{ "quotient": [a, b] }`, sans valeur
 * si un terme manque (ou division par zéro).
 * Conditions : `all`, `any`, `not`, `exists`, `missing`, `eq`, `ne`, `lt`, `le`, `gt`, `ge`
 * (nombres convertis comme `float()` de Python), `matches` (expression régulière),
 * `sectionExists` (nom de section, expression régulière).
 */

/** Format 3 (EP-07.04, ADR 0032) : signatures d'erreurs du journal (`logSignatures`). */
export const RULES_FORMAT = 3;

export type RuleValue =
  | {
      readonly option: string;
      readonly section?: string;
      /** Première section dont le nom correspond (expression régulière), à la place de `section`. */
      readonly sectionMatch?: string;
      readonly index?: number;
      readonly default?: number | string;
    }
  | { readonly number: number }
  | { readonly text: string }
  | { readonly sum: readonly RuleValue[] }
  | { readonly difference: readonly [RuleValue, RuleValue] }
  | { readonly product: readonly RuleValue[] }
  | { readonly quotient: readonly [RuleValue, RuleValue] };

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
  /** Signatures d'erreurs du `klippy.log` (format 3, EP-07.04). */
  readonly logSignatures?: readonly LogSignature[];
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

/** Section désignée par une valeur : évaluée, nommée, ou première correspondant au motif. */
function sectionOf(
  value: Extract<RuleValue, { option: string }>,
  ctx: Context,
): ConfigSection | undefined {
  if (value.sectionMatch !== undefined) {
    const pattern = regex(value.sectionMatch);
    return [...ctx.byName.values()].find((s) => pattern.test(s.name));
  }
  return value.section === undefined ? ctx.section : ctx.byName.get(value.section);
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

function resolve(value: RuleValue, ctx: Context): Scalar {
  if ("number" in value) return value.number;
  if ("text" in value) return value.text;
  const operation =
    "sum" in value
      ? { terms: value.sum, apply: (n: number[]) => n.reduce((a, b) => a + b, 0) }
      : "difference" in value
        ? { terms: value.difference, apply: ([a = 0, b = 0]: number[]) => a - b }
        : "product" in value
          ? { terms: value.product, apply: (n: number[]) => n.reduce((a, b) => a * b, 1) }
          : "quotient" in value
            ? {
                terms: value.quotient,
                apply: ([a = 0, b = 0]: number[]) => (b === 0 ? Number.NaN : a / b),
              }
            : undefined;
  if (operation) {
    const terms = operation.terms.map((v) => asNumber(resolve(v, ctx)));
    if (terms.some((t) => t === undefined || Number.isNaN(t))) return undefined;
    const result = operation.apply(terms as number[]);
    // Arrondi d'affichage : 0,1 + 0,2 ne doit pas donner 0,30000000000000004.
    return Number.isFinite(result) ? Math.round(result * 1e9) / 1e9 : undefined;
  }
  if (!("option" in value)) return undefined;
  const section = sectionOf(value, ctx);
  // Section désignée absente (imprimante delta sans [stepper_x]) : pas de valeur, même par défaut.
  if (!section) return undefined;
  const option = section.options.get(value.option);
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
  options: {
    readonly partial?: boolean;
    /**
     * Sections consultables par les règles sans être évaluées : l'imprimante choisie par
     * l'utilisateur (`zipero_printer`, EP-06.05). Une section de la configuration l'emporte.
     */
    readonly context?: readonly ConfigSection[];
  } = {},
): RuleHit[] {
  if (bundle.format !== RULES_FORMAT) return [];
  const byName = new Map([...(options.context ?? []), ...sections].map((s) => [s.name, s]));
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
