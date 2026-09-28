// SPDX-License-Identifier: GPL-3.0-only
import { splitLines } from "../text/lines";

/**
 * Lecture d'une configuration Klipper, fidèle à `configparser.RawConfigParser(strict=False,
 * inline_comment_prefixes=(';', '#'))` utilisé par klippy/configfile.py :
 * - sections `[nom]`, options `clé: valeur` ou `clé = valeur` (clés en minuscules) ;
 * - valeur sur plusieurs lignes : lignes suivantes plus indentées que l'option ;
 * - commentaires : ligne commençant par `#` ou `;`, ou `#`/`;` précédé d'un espace ;
 * - `strict=False` : une section ou option répétée remplace la précédente ;
 * - bloc SAVE_CONFIG : les lignes `#*# ` sont lues comme de la configuration (priorité finale).
 *
 * Socle du parseur complet du validateur (EP-06.01), qui ajoutera `[include]` et le diagnostic.
 */

export interface ConfigOption {
  readonly name: string;
  /** Valeur brute ; lignes de continuation jointes par « \n ». */
  readonly value: string;
  readonly line: number;
  /** true si l'option provient du bloc SAVE_CONFIG (`#*#`). */
  readonly autosave: boolean;
}

export interface ConfigSection {
  readonly name: string;
  readonly line: number;
  readonly options: ReadonlyMap<string, ConfigOption>;
}

const AUTOSAVE_HEADER = [
  /^#\*# <-+ SAVE_CONFIG -+>$/,
  /^#\*# DO NOT EDIT THIS BLOCK OR BELOW\. The contents are auto-generated\.$/,
  /^#\*#$/,
];

/** Retire un commentaire en fin de ligne (`#` ou `;` précédé d'un blanc). */
function stripInlineComment(text: string): string {
  const match = /\s[#;]/.exec(text);
  return (match ? text.slice(0, match.index) : text).trimEnd();
}

interface MutableSection {
  name: string;
  line: number;
  options: Map<string, ConfigOption>;
}

export function parseConfig(source: string): ConfigSection[] {
  const sections = new Map<string, MutableSection>();
  let section: MutableSection | undefined;
  let option:
    | { name: string; indent: number; lines: string[]; line: number; autosave: boolean }
    | undefined;

  const flush = () => {
    if (section && option) {
      section.options.set(option.name, {
        name: option.name,
        value: option.lines.join("\n").trim(),
        line: option.line,
        autosave: option.autosave,
      });
    }
    option = undefined;
  };

  for (const { line, text: raw } of splitLines(source)) {
    let text = raw;
    let autosave = false;
    if (raw.startsWith("#*#")) {
      if (AUTOSAVE_HEADER.some((pattern) => pattern.test(raw.trimEnd()))) continue;
      text = raw.startsWith("#*# ") ? raw.slice(4) : raw.slice(3);
      autosave = true;
    }

    const trimmed = text.trim();
    if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;

    const indent = text.length - text.trimStart().length;
    const content = stripInlineComment(trimmed);

    // Ligne de continuation : plus indentée que l'option en cours.
    if (option && indent > option.indent) {
      if (content !== "") option.lines.push(content);
      continue;
    }

    const header = /^\[(.+)\]/.exec(trimmed);
    if (header?.[1]) {
      flush();
      const name = header[1].trim();
      section = sections.get(name) ?? { name, line, options: new Map() };
      sections.set(name, section);
      continue;
    }

    const delimiter = /[:=]/.exec(content);
    if (!section || !delimiter) {
      flush();
      continue;
    }
    flush();
    option = {
      name: content.slice(0, delimiter.index).trim().toLowerCase(),
      indent,
      lines: [content.slice(delimiter.index + 1).trim()],
      line,
      autosave,
    };
  }
  flush();
  return [...sections.values()];
}
