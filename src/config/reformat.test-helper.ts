// SPDX-License-Identifier: GPL-3.0-only
import fc from "fast-check";
import type { ConfigReadResult } from "./ini";
import type { ValidationIssue } from "./validate";

/**
 * Reformatage d'une configuration qui ne change rien pour Klipper (EP-19.03). Chaque
 * transformation repose sur une règle de klippy/configfile.py et de configparser, vérifiée
 * contre le vrai Klipper par les cas limites de `tooling/corpus-tests/fixtures/config-edge`
 * (`config_oracle.py`) :
 * - fins de ligne CRLF (`crlf.cfg`) ;
 * - nom d'option en majuscules, lu en minuscules (`repeat-and-case.cfg`) ; jamais le nom d'une
 *   section, qui garde sa casse (même cas) ;
 * - `:` ou `=`, entourés de blancs (`repeat-and-case.cfg`, `empty-values.cfg`) ;
 * - blancs en fin de ligne, retirés de la valeur (`multiline.cfg`) ;
 * - commentaire `#` ajouté en fin de ligne, que Klipper retire jusqu'au bout de la ligne
 *   (`hash-anywhere.cfg`) ;
 * - lignes vides et lignes de commentaire (`#`, `;`) ajoutées avant une section : les lignes
 *   vides qui terminent une valeur sont retirées par configparser (`multiline.cfg`).
 * Le bloc SAVE_CONFIG (`#*#`), au format strict, n'est jamais touché, sauf ses fins de ligne.
 */

const AUTOSAVE = /^#\*# <-+ SAVE_CONFIG -+>/;
/** Ligne d'option sûre à réécrire : nom ASCII en début de ligne, avant tout `#`. */
const OPTION_LINE = /^([A-Za-z0-9_]+)[ \t]*([:=])[ \t]*([^#]*)$/;
const SECTION_LINE = /^\[[^\]\n#]+\][ \t]*$/;

interface LineChoice {
  readonly upper: boolean;
  readonly delimiter: ":" | "=";
  readonly before: string;
  readonly after: string;
  readonly trailing: string;
  readonly comment: boolean;
  readonly preamble: readonly string[];
}

const lineChoice: fc.Arbitrary<LineChoice> = fc.record({
  upper: fc.boolean(),
  delimiter: fc.constantFrom(":" as const, "=" as const),
  before: fc.constantFrom("", " ", "  ", "\t"),
  after: fc.constantFrom("", " ", "  ", "\t"),
  trailing: fc.constantFrom("", "", " ", "\t", "  "),
  comment: fc.boolean(),
  preamble: fc.array(fc.constantFrom("", "# commentaire ajouté", "; commentaire ajouté", "   "), {
    maxLength: 3,
  }),
});

/** Plan de reformatage : un choix par ligne (réutilisé en boucle), fins de ligne CRLF ou non. */
export const reformatPlan = fc.record({
  crlf: fc.boolean(),
  lines: fc.array(lineChoice, { minLength: 1, maxLength: 40 }),
});
export type ReformatPlan = typeof reformatPlan extends fc.Arbitrary<infer T> ? T : never;

/** Applique un plan à un texte de configuration. */
export function reformat(text: string, plan: ReformatPlan): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const end = lines.findIndex((line) => AUTOSAVE.test(line));
  const body = end === -1 ? lines : lines.slice(0, end);
  const out: string[] = [];
  body.forEach((line, index) => {
    const choice = plan.lines[index % plan.lines.length] as LineChoice;
    if (SECTION_LINE.test(line)) {
      out.push(...choice.preamble, line.trimEnd() + choice.trailing);
      return;
    }
    const option = OPTION_LINE.exec(line);
    if (option) {
      const [, name = "", , value = ""] = option;
      const shown = choice.upper ? name.toUpperCase() : name;
      const rewritten = `${shown}${choice.before}${choice.delimiter}${choice.after}${value.trimEnd()}`;
      out.push(rewritten + choice.trailing + (choice.comment ? " # ajouté" : ""));
      return;
    }
    // Suite d'une valeur, déjà sans `#` : blancs ou commentaire en fin de ligne.
    if (/^[ \t]+\S/.test(line) && !line.includes("#")) {
      out.push(line + choice.trailing + (choice.comment ? " # ajouté" : ""));
      return;
    }
    out.push(line);
  });
  const all = end === -1 ? out : [...out, ...lines.slice(end)];
  return all.join(plan.crlf ? "\r\n" : "\n");
}

/**
 * Problème sans ses numéros de ligne : `line`, et les paramètres qui en sont (`definedLine`,
 * `otherLine`) ; ajouter une ligne vide les décale sans rien changer d'autre.
 */
function withoutLines<T extends { readonly line?: number; readonly params?: object }>(issue: T) {
  const { line: _line, params, ...rest } = issue;
  return {
    ...rest,
    params: Object.fromEntries(
      Object.entries(params ?? {}).filter(([key]) => !key.endsWith("Line")),
    ),
  };
}

/** Ce que Klipper retient d'une lecture, sans les numéros de ligne. */
export function readSummary(result: ConfigReadResult) {
  return {
    sections: result.sections.map((section) => ({
      name: section.name,
      file: section.file,
      options: [...section.options.values()].map((o) => [o.name, o.value, o.autosave]),
    })),
    problems: result.problems.map(withoutLines),
    filesRead: result.filesRead,
  };
}

/** Diagnostics de la vérification, sans les numéros de ligne. */
export function issueSummary(issues: readonly ValidationIssue[]) {
  return issues.map(withoutLines);
}
