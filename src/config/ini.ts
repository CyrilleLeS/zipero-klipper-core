// SPDX-License-Identifier: GPL-3.0-only
import type { Issue } from "../result";
import { dirname, hasMagic, joinPath, matchesGlob, normalizePath } from "./paths";

/**
 * Lecture d'une configuration Klipper (EP-06.01), portage fidèle de klippy/configfile.py
 * (Klipper commit 214fdb2877) et de `configparser.RawConfigParser(strict=False,
 * inline_comment_prefixes=(';', '#'))` qu'il utilise :
 * 1. bloc SAVE_CONFIG séparé du fichier principal (`_find_autosave_data`), ignoré s'il est
 *    corrompu ;
 * 2. fichier principal lu avec ses `[include …]` (chemin relatif au fichier qui inclut, jokers
 *    triés, fichier absent refusé sauf joker, inclusion récursive refusée), par morceaux entre
 *    deux inclusions pour que les surcharges s'appliquent dans l'ordre ;
 * 3. options du bloc SAVE_CONFIG déjà définies ailleurs neutralisées (`_strip_duplicates`) :
 *    la valeur du fichier l'emporte, puis le reste du bloc est fusionné.
 * Règles de lecture : `#` commente tout le reste de la ligne (Klipper le retire avant
 * configparser) ; `;` seulement en début de ligne ou précédé d'un blanc ; `clé: valeur` ou
 * `clé = valeur`, clé en minuscules ; ligne plus indentée que l'option = suite de sa valeur ;
 * section ou option répétée : la dernière l'emporte. Blancs au sens de Python (`str.isspace`).
 *
 * Là où Klipper refuse de démarrer (ligne illisible, fichier inclus absent…), la lecture
 * continue et le problème est signalé avec son fichier et sa ligne.
 */

export interface ConfigOption {
  readonly name: string;
  /** Valeur brute ; lignes de continuation jointes par « \n ». */
  readonly value: string;
  readonly file: string;
  readonly line: number;
  /**
   * Ligne du fichier de chaque ligne de la valeur (`value.split("\n")[i]` → `valueLines[i]`) :
   * les lignes de commentaire, retirées de la valeur, décalent la numérotation.
   */
  readonly valueLines: readonly number[];
  /** true si l'option provient du bloc SAVE_CONFIG (`#*#`). */
  readonly autosave: boolean;
}

export interface ConfigSection {
  readonly name: string;
  /** Première apparition de la section. */
  readonly file: string;
  readonly line: number;
  readonly options: ReadonlyMap<string, ConfigOption>;
}

/** Tous les codes possibles (l'interface vérifie qu'ils sont tous traduits). */
export const CONFIG_READ_CODES = [
  /** Option avant toute section (Klipper : « File contains no section headers »). */
  "config.no-section",
  /** Ligne sans `:` ni `=`, ou sans nom d'option (Klipper : « Source contains parsing errors »). */
  "config.parse-error",
  /** `[include]` d'un fichier absent (non fourni, ou absent sur l'imprimante). */
  "config.include-missing",
  /** Inclusion récursive (Klipper : « Recursive include of config file »). */
  "config.include-recursive",
  /** Bloc SAVE_CONFIG illisible pour Klipper, qui l'ignore entièrement. */
  "config.autosave-corrupted",
  /** Option du bloc SAVE_CONFIG ignorée : la même option est définie dans la configuration. */
  "config.autosave-overridden",
  /** Bloc SAVE_CONFIG dans un fichier inclus : Klipper ne le lit que dans le fichier principal. */
  "config.autosave-in-include",
] as const;

export type ConfigReadCode = (typeof CONFIG_READ_CODES)[number];

export interface ConfigProblem extends Issue<ConfigReadCode> {
  readonly file: string;
  readonly line: number;
}

export interface ConfigInput {
  /** Fichiers fournis : chemin relatif (séparateur `/`) → contenu. */
  readonly files: ReadonlyMap<string, string>;
  /** Chemin du fichier principal (printer.cfg). */
  readonly main: string;
}

export interface ConfigReadOptions {
  /**
   * Lecture tolérante du bloc SAVE_CONFIG (outil Bed mesh) : lignes `#*# ` lues même sans
   * l'en-tête exact, pour les extraits collés. Klipper, lui, les ignorerait.
   */
  readonly lenientAutosave?: boolean;
}

export interface ConfigReadResult {
  readonly sections: readonly ConfigSection[];
  readonly problems: readonly ConfigProblem[];
  /** Fichiers lus, dans l'ordre de lecture (un fichier inclus deux fois apparaît deux fois). */
  readonly filesRead: readonly string[];
}

/** Blancs de Python (`str.isspace`, `\s` de `re`) : différents de ceux de JavaScript (BOM). */
const PY_SPACE =
  "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const LEADING_SPACE = new RegExp(`^[${PY_SPACE}]+`);
const TRAILING_SPACE = new RegExp(`[${PY_SPACE}]+$`);
const NON_SPACE = new RegExp(`[^${PY_SPACE}]`);
const isPySpace = (char: string) => new RegExp(`^[${PY_SPACE}]$`).test(char);
const pyStrip = (text: string) => text.replace(LEADING_SPACE, "").replace(TRAILING_SPACE, "");
const pyRstrip = (text: string) => text.replace(TRAILING_SPACE, "");

/** `SECTCRE` de configparser, appliqué avec `match` (début de chaîne). */
const SECTION = /^\[([^\n]+)\]/;
/** `OPTCRE` : nom (le plus court) jusqu'au premier `=` ou `:`. */
const OPTION = new RegExp(`^([^\\n]*?)[${PY_SPACE}]*([=:])[${PY_SPACE}]*([^\\n]*)$`);

const AUTOSAVE_HEADER =
  "\n#*# <---------------------- SAVE_CONFIG ---------------------->\n" +
  "#*# DO NOT EDIT THIS BLOCK OR BELOW. The contents are auto-generated.\n#*#\n";

interface Line {
  readonly line: number;
  readonly text: string;
}

interface MutableSection {
  readonly name: string;
  readonly file: string;
  readonly line: number;
  readonly options: Map<string, ConfigOption>;
}

/** Lignes d'un texte aux fins de ligne déjà normalisées en LF. */
function linesOf(text: string, firstLine = 1): Line[] {
  return text.split("\n").map((content, index) => ({ line: firstLine + index, text: content }));
}

/** Klipper retire tout ce qui suit le premier `#` de chaque ligne. */
const stripHash = (text: string) => {
  const index = text.indexOf("#");
  return index >= 0 ? text.slice(0, index) : text;
};

/** Début du commentaire `;` (en début de ligne ou précédé d'un blanc), ou -1. */
function inlineCommentStart(text: string): number {
  let index = text.indexOf(";");
  while (index >= 0) {
    if (index === 0 || isPySpace(text[index - 1] ?? "")) return index;
    index = text.indexOf(";", index + 1);
  }
  return -1;
}

class Store {
  readonly sections = new Map<string, MutableSection>();
  readonly problems: ConfigProblem[] = [];

  hasOption(section: string, option: string): ConfigOption | undefined {
    return this.sections.get(section)?.options.get(option.toLowerCase());
  }

  /** Un appel de `RawConfigParser.read_file` : l'état (section en cours) repart de zéro. */
  readChunk(lines: readonly Line[], file: string, autosave: boolean) {
    let section: MutableSection | undefined;
    let option: { name: string; lines: string[]; sourceLines: number[]; line: number } | undefined;
    let indentLevel = 0;
    const flush = () => {
      if (section && option) {
        const value = pyRstrip(option.lines.join("\n"));
        section.options.set(option.name, {
          name: option.name,
          value,
          file,
          line: option.line,
          valueLines: option.sourceLines.slice(0, value.split("\n").length),
          autosave,
        });
      }
    };

    for (const { line, text: raw } of lines) {
      const text = stripHash(raw);
      const trimmed = pyStrip(text);
      const fullComment = trimmed.startsWith(";");
      const inline = inlineCommentStart(text);
      const hasComment = fullComment || inline >= 0;
      const value = fullComment ? "" : pyStrip(inline >= 0 ? text.slice(0, inline) : text);

      if (value === "") {
        // Ligne vide dans une valeur (empty_lines_in_values), sauf si c'était un commentaire.
        if (!hasComment && section && option) {
          option.lines.push("");
          option.sourceLines.push(line);
        }
        continue;
      }
      const indent = text.search(NON_SPACE);
      if (section && option && indent > indentLevel) {
        option.lines.push(value);
        option.sourceLines.push(line);
        continue;
      }
      indentLevel = indent;

      const header = SECTION.exec(value);
      if (header?.[1] !== undefined) {
        flush();
        option = undefined;
        const name = header[1];
        section = this.sections.get(name);
        if (!section) {
          section = { name, file, line, options: new Map() };
          this.sections.set(name, section);
        }
        continue;
      }
      if (!section) {
        this.problems.push({ code: "config.no-section", file, line });
        continue;
      }
      const match = OPTION.exec(value);
      const name = match?.[1] !== undefined ? pyRstrip(match[1]) : "";
      if (!match || name === "") {
        this.problems.push({ code: "config.parse-error", file, line });
        continue;
      }
      flush();
      option = {
        name: name.toLowerCase(),
        lines: [pyStrip(match[3] ?? "")],
        sourceLines: [line],
        line,
      };
    }
    flush();
  }
}

interface Autosave {
  readonly regular: string;
  /** Contenu du bloc, préfixes `#*# ` retirés, avec ses numéros de ligne dans le fichier. */
  readonly lines: readonly Line[];
}

/** `_find_autosave_data` : sépare le bloc SAVE_CONFIG ; corrompu → ignoré (avertissement). */
function findAutosave(data: string, file: string, store: Store, lenient: boolean): Autosave {
  const position = data.indexOf(AUTOSAVE_HEADER);
  const raw = position >= 0 ? data.slice(position + AUTOSAVE_HEADER.length) : "";
  const regular = position >= 0 ? data.slice(0, position) : data;
  const autosave = pyStrip(raw);
  const start =
    position >= 0
      ? position + AUTOSAVE_HEADER.length + (raw.length - raw.replace(LEADING_SPACE, "").length)
      : 0;
  const firstLine = data.slice(0, start).split("\n").length;
  const corrupt = (reason: string, line: number): Autosave => {
    if (lenient) return lenientAutosave(data);
    store.problems.push({ code: "config.autosave-corrupted", file, line, params: { reason } });
    return { regular: data, lines: [] };
  };

  const stray = regular.indexOf("\n#*# ");
  if (stray >= 0 || autosave.includes(AUTOSAVE_HEADER)) {
    const line = stray >= 0 ? regular.slice(0, stray + 1).split("\n").length : firstLine;
    return corrupt(position >= 0 ? "outside-block" : "no-header", line);
  }
  if (position < 0) {
    // Extrait collé commençant directement par `#*#` : Klipper n'y verrait que des commentaires.
    return lenient && /^#\*#/m.test(data) ? lenientAutosave(data) : { regular: data, lines: [] };
  }

  const lines = linesOf(autosave, firstLine);
  for (const { line, text } of lines) {
    if ((!text.startsWith("#*#") || (text.length >= 4 && !text.startsWith("#*# "))) && autosave) {
      return corrupt("modified", line);
    }
  }
  return {
    regular,
    lines: [
      { line: firstLine, text: "" },
      ...lines.map(({ line, text }) => ({ line, text: text.slice(4) })),
      { line: firstLine + lines.length, text: "" },
    ],
  };
}

/** Mode tolérant : toute ligne `#*# ` est lue comme bloc SAVE_CONFIG, où qu'elle soit. */
function lenientAutosave(data: string): Autosave {
  const all = linesOf(data);
  return {
    regular: all.map(({ text }) => (text.startsWith("#*#") ? "" : text)).join("\n"),
    lines: all.flatMap(({ line, text }) =>
      text.startsWith("#*#") && !/^#\*# (?:<-+ SAVE_CONFIG|DO NOT EDIT)/.test(text)
        ? [{ line, text: text.slice(4) }]
        : [],
    ),
  };
}

/** `_strip_duplicates` : neutralise les options du bloc déjà définies dans la configuration. */
function stripDuplicates(lines: readonly Line[], file: string, store: Store): Line[] {
  let section: string | undefined;
  let duplicate = false;
  return lines.map((entry) => {
    const pruned = pyRstrip(entry.text.replace(/[#;][^\n]*$/, ""));
    if (pruned === "") return entry;
    if (isPySpace(pruned[0] ?? "")) return duplicate ? { ...entry, text: `#${entry.text}` } : entry;
    duplicate = false;
    if (pruned.startsWith("[")) {
      section = pyStrip(pruned.slice(1, -1));
      return entry;
    }
    const field = pruned.replace(/[^A-Za-z0-9_][^\n]*$/, "");
    const existing = section === undefined ? undefined : store.hasOption(section, field);
    if (!existing) return entry;
    duplicate = true;
    store.problems.push({
      code: "config.autosave-overridden",
      file,
      line: entry.line,
      params: {
        section: section ?? "",
        option: field.toLowerCase(),
        definedIn: existing.file,
        definedLine: existing.line,
        // Défini dans un fichier inclus : le prochain SAVE_CONFIG échouera.
        included: existing.file === file ? 0 : 1,
      },
    });
    return { ...entry, text: `#${entry.text}` };
  });
}

export function readConfig(input: ConfigInput, options: ConfigReadOptions = {}): ConfigReadResult {
  const store = new Store();
  const files = new Map(
    // Fichier ouvert en mode texte par Python : CRLF et CR seul deviennent LF.
    [...input.files].map(([path, text]) => [normalizePath(path), text.replace(/\r\n?/g, "\n")]),
  );
  const filesRead: string[] = [];
  const visited = new Set<string>();

  const parseFile = (data: string, file: string, from?: { file: string; line: number }) => {
    if (visited.has(file)) {
      store.problems.push({
        code: "config.include-recursive",
        file: from?.file ?? file,
        line: from?.line ?? 1,
        params: { include: file },
      });
      return;
    }
    visited.add(file);
    filesRead.push(file);
    let buffer: Line[] = [];
    for (const entry of linesOf(data)) {
      const text = stripHash(entry.text);
      const header = SECTION.exec(text)?.[1];
      if (header?.startsWith("include ")) {
        store.readChunk(buffer, file, false);
        buffer = [];
        resolveInclude(file, entry.line, pyStrip(header.slice(8)));
      } else {
        buffer.push(entry);
      }
    }
    store.readChunk(buffer, file, false);
    visited.delete(file);
  };

  const resolveInclude = (file: string, line: number, spec: string) => {
    const pattern = spec.startsWith("/") ? spec : joinPath(dirname(file), spec);
    const matches = hasMagic(pattern)
      ? [...files.keys()].filter((path) => matchesGlob(pattern, path)).sort()
      : files.has(normalizePath(pattern))
        ? [normalizePath(pattern)]
        : [];
    if (matches.length === 0 && !hasMagic(pattern)) {
      store.problems.push({
        code: "config.include-missing",
        file,
        line,
        params: { include: spec },
      });
      return;
    }
    for (const path of matches) {
      const data = files.get(path) ?? "";
      if (data.includes(AUTOSAVE_HEADER)) {
        store.problems.push({ code: "config.autosave-in-include", file: path, line: 1 });
      }
      parseFile(data, path, { file, line });
    }
  };

  const main = normalizePath(input.main);
  const data = files.get(main) ?? "";
  const autosave = findAutosave(data, main, store, options.lenientAutosave ?? false);
  parseFile(autosave.regular, main);
  const merged = stripDuplicates(autosave.lines, main, store);
  store.readChunk(
    merged.map(({ line, text }) => ({ line, text: stripHash(text) })),
    main,
    true,
  );

  return { sections: [...store.sections.values()], problems: store.problems, filesRead };
}

/**
 * Lecture d'un seul fichier (outil Bed mesh, extraction de la mécanique) : bloc SAVE_CONFIG
 * lu en mode tolérant, les `[include]` restent sans effet faute de fichiers.
 */
export function parseConfig(source: string): ConfigSection[] {
  const main = "printer.cfg";
  return [
    ...readConfig({ files: new Map([[main, source]]), main }, { lenientAutosave: true }).sections,
  ];
}
