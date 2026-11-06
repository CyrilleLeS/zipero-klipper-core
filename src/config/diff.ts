// SPDX-License-Identifier: GPL-3.0-only
import type { ConfigOption, ConfigSection } from "./ini";
import { pyFloat } from "./values";

/**
 * Comparaison de deux configurations (EP-06.11) : avant/après une mise à jour, ou face à la
 * configuration d'origine d'un modèle. Comparées telles que Klipper les lit (fichiers inclus
 * fusionnés, bloc SAVE_CONFIG appliqué : `readConfig`), section par section, option par option.
 *
 * Deux valeurs sont égales (choix de Zipero, sans effet sur la lecture par Klipper) si elles le
 * sont une fois chaque ligne débarrassée des blancs de début et de fin et ses blancs internes
 * ramenés à un seul (lignes vides ignorées), ou si ce sont deux nombres égaux (`0.110` et `0.11`,
 * lus par `getfloat`).
 */

export type DiffStatus = "added" | "removed" | "changed";

export interface OptionDiff {
  readonly name: string;
  readonly status: DiffStatus;
  /** Valeur dans A (référence ou version précédente). */
  readonly before?: string;
  /** Valeur dans B (configuration vérifiée). */
  readonly after?: string;
  /** Emplacement dans B, quand l'option y est (ou dans A sinon). */
  readonly file: string;
  readonly line: number;
  /** true si la valeur de B vient du bloc SAVE_CONFIG. */
  readonly autosave: boolean;
}

export interface SectionDiff {
  readonly name: string;
  /** added : seulement dans B ; removed : seulement dans A ; changed : options différentes. */
  readonly status: DiffStatus;
  readonly options: readonly OptionDiff[];
}

export interface ConfigDiff {
  readonly sections: readonly SectionDiff[];
  readonly counts: {
    readonly sectionsAdded: number;
    readonly sectionsRemoved: number;
    readonly optionsChanged: number;
    readonly optionsAdded: number;
    readonly optionsRemoved: number;
  };
}

/** Valeur ramenée à sa forme comparable (voir l'en-tête). */
export function normalizeValue(value: string): string {
  return value
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter((line) => line !== "")
    .join("\n");
}

export function sameValue(a: string, b: string): boolean {
  const left = normalizeValue(a);
  const right = normalizeValue(b);
  if (left === right) return true;
  const x = pyFloat(left);
  const y = pyFloat(right);
  return x !== undefined && y !== undefined && x === y;
}

const optionDiff = (
  name: string,
  status: DiffStatus,
  before: ConfigOption | undefined,
  after: ConfigOption | undefined,
): OptionDiff => {
  const where = (after ?? before) as ConfigOption;
  return {
    name,
    status,
    ...(before ? { before: before.value } : {}),
    ...(after ? { after: after.value } : {}),
    file: where.file,
    line: where.line,
    autosave: after?.autosave ?? false,
  };
};

export function diffConfigs(a: readonly ConfigSection[], b: readonly ConfigSection[]): ConfigDiff {
  const inA = new Map(a.map((s) => [s.name, s]));
  const inB = new Map(b.map((s) => [s.name, s]));
  const sections: SectionDiff[] = [];

  for (const section of b) {
    const previous = inA.get(section.name);
    if (!previous) {
      sections.push({
        name: section.name,
        status: "added",
        options: [...section.options.values()].map((o) =>
          optionDiff(o.name, "added", undefined, o),
        ),
      });
      continue;
    }
    const options: OptionDiff[] = [];
    for (const option of section.options.values()) {
      const old = previous.options.get(option.name);
      if (!old) options.push(optionDiff(option.name, "added", undefined, option));
      else if (!sameValue(old.value, option.value)) {
        options.push(optionDiff(option.name, "changed", old, option));
      }
    }
    for (const old of previous.options.values()) {
      if (!section.options.has(old.name))
        options.push(optionDiff(old.name, "removed", old, undefined));
    }
    if (options.length > 0) sections.push({ name: section.name, status: "changed", options });
  }
  for (const section of a) {
    if (inB.has(section.name)) continue;
    sections.push({
      name: section.name,
      status: "removed",
      options: [...section.options.values()].map((o) =>
        optionDiff(o.name, "removed", o, undefined),
      ),
    });
  }

  const changedOptions = sections.filter((s) => s.status === "changed").flatMap((s) => s.options);
  return {
    sections,
    counts: {
      sectionsAdded: sections.filter((s) => s.status === "added").length,
      sectionsRemoved: sections.filter((s) => s.status === "removed").length,
      optionsChanged: changedOptions.filter((o) => o.status === "changed").length,
      optionsAdded: changedOptions.filter((o) => o.status === "added").length,
      optionsRemoved: changedOptions.filter((o) => o.status === "removed").length,
    },
  };
}
