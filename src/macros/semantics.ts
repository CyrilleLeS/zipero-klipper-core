// SPDX-License-Identifier: GPL-3.0-only
// Sens des macros (EP-06.08) : ce que Klipper refuse au démarrage (nom de macro, collision de
// commandes, rename_existing, variable qui n'est pas un littéral) et ce qui échouera ou agira mal
// à l'exécution (paramètre jamais reçu, objet ou variable inexistants, SET_GCODE_VARIABLE,
// appel récursif, commande inconnue). Comportements relevés dans klippy/gcode.py et
// klippy/extras/gcode_macro.py, delayed_gcode.py (identiques dans Kalico et les forks).

import type { FirmwareId } from "../config/firmwares";
import type { ConfigOption, ConfigSection } from "../config/ini";
import type { ConfigSchema } from "../config/validate";
import { pyFloat, pyStrip } from "../config/values";
import {
  children,
  EXPRESSION_MARK,
  type Expr,
  jinjaEnvironment,
  type Node,
  parseTemplate,
  templateLines,
} from "./jinja";
import { checkMacroLiteral } from "./pyliteral";
import { fileLineOf, type MacroTemplate, macroTemplates } from "./templates";

export const MACRO_CODES = [
  "macro.name-whitespace",
  "macro.invalid-name",
  "macro.command-exists",
  "macro.rename-type",
  "macro.rename-missing",
  "macro.rename-invalid-name",
  "macro.rename-taken",
  "macro.variable-literal",
  "macro.param-case",
  "macro.param-default",
  "macro.unknown-object",
  "macro.unknown-variable",
  "macro.set-variable-macro",
  "macro.set-variable-unknown",
  "macro.set-variable-value",
  "macro.delayed-gcode-unknown",
  "macro.recursive",
  "macro.unknown-command",
  "macro.config-line",
] as const;

export type MacroCode = (typeof MACRO_CODES)[number];

export interface MacroCheckIssue {
  readonly code: MacroCode;
  /** error : Klipper refusera de démarrer ; warning : échec ou effet inattendu à l'exécution ; info : à vérifier. */
  readonly severity: "error" | "warning" | "info";
  readonly section: string;
  readonly option?: string;
  readonly file: string;
  readonly line: number;
  readonly params?: Readonly<Record<string, string>>;
}

export interface MacroCheckOptions {
  /** Configuration incomplète (fichier inclus absent) : pas d'alerte fondée sur une absence. */
  readonly partial?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Règles de Klipper (gcode.py)

// biome-ignore lint/suspicious/noControlCharactersInRegex: blancs de Python (str.split)
const PY_WHITESPACE = /[\s\x1c-\x1f\x85]+/u;
const pySplit = (text: string) => pyStrip(text).split(PY_WHITESPACE).filter(Boolean);
const isDigit = (char: string | undefined) => char !== undefined && /^\p{Nd}$/u.test(char);
const isUpper = (char: string | undefined) =>
  char !== undefined && char !== char.toLowerCase() && char === char.toUpperCase();

/** `is_traditional_gcode` : une lettre suivie d'un nombre (G1, M117, G28.1). */
export function isTraditionalGcode(command: string): boolean {
  const first = pySplit(command.toUpperCase())[0];
  if (!first || first.length < 2 || pyFloat(first.slice(1)) === undefined) return false;
  return isUpper(first[0]) && isDigit(first[1]);
}

/** Nom acceptable par `register_command` pour une commande étendue (non traditionnelle). */
function validExtendedName(command: string): boolean {
  return (
    command.toUpperCase() === command &&
    /^[\p{L}\p{N}]+$/u.test(command.replace(/_/g, "A")) &&
    !isDigit(command[0]) &&
    !isDigit(command[1])
  );
}

const registrable = (command: string) => isTraditionalGcode(command) || validExtendedName(command);

/** Découpage d'une ligne de G-code comme `_process_commands` : commande et paramètres. */
export function klipperCommand(
  line: string,
):
  | { readonly command: string; readonly params: Record<string, string>; readonly raw: string }
  | undefined {
  const origline = pyStrip(line);
  const comment = origline.indexOf(";");
  const text = comment >= 0 ? origline.slice(0, comment) : origline;
  const parts = text.toUpperCase().split(/([A-Z_]+|[A-Z*])/);
  const command = pyStrip(
    (parts[0] ?? "") + (parts[1] ?? "") === "N"
      ? (parts[3] ?? "") + (parts[4] ?? "")
      : (parts[0] ?? "") + (parts[1] ?? "") + (parts[2] ?? ""),
  );
  if (command === "") return undefined;
  const params: Record<string, string> = {};
  for (let i = 1; i < parts.length; i += 2) params[parts[i] ?? ""] = pyStrip(parts[i + 1] ?? "");
  return { command, params, raw: origline };
}

/**
 * Paramètres d'une commande étendue (`_get_extended_params`) : `CLÉ=valeur`, guillemets comme
 * shlex, commentaire après `;` ou `#` ; undefined si un mot n'a pas de `=` (« Malformed command »).
 */
function extendedParams(raw: string, command: string): Record<string, string> | undefined {
  const upper = raw.toUpperCase();
  let rest = upper.startsWith(command) ? raw : raw.slice(Math.max(0, upper.indexOf(command)));
  rest = rest.slice(command.length).replace(/^ /, "");
  const words: string[] = [];
  let word: string | undefined;
  let quote: string | undefined;
  for (const char of rest) {
    if (quote) {
      if (char === quote) quote = undefined;
      else word = (word ?? "") + char;
    } else if (char === '"' || char === "'") {
      quote = char;
      word ??= "";
    } else if (char === ";" || char === "#") {
      if (word === undefined) break;
      word += char;
    } else if (/\s/.test(char)) {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else word = (word ?? "") + char;
  }
  if (word !== undefined) words.push(word);
  const params: Record<string, string> = {};
  for (const entry of words) {
    const equal = entry.indexOf("=");
    if (equal < 0) return undefined;
    params[entry.slice(0, equal).toUpperCase()] = entry.slice(equal + 1);
  }
  return params;
}

/** Commandes que `cmd_default` ignore sans message (pas de commande inconnue). */
function silentlyIgnored(command: string, params: Record<string, string>): boolean {
  const value = (key: string, fallback: number) => {
    const text = params[key];
    if (text === undefined) return fallback;
    return text.includes(EXPRESSION_MARK) ? undefined : (pyFloat(text) ?? undefined);
  };
  if (command === "M105" || command === "M21" || command === "M107") return true;
  if (command === "M140" || command === "M104")
    return value("S", 0) !== undefined ? !value("S", 0) : true;
  if (command === "M106") {
    const speed = value("S", 1);
    return speed === undefined || !speed;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------

interface Macro {
  readonly section: ConfigSection;
  /** Nom tel qu'écrit (clé de SET_GCODE_VARIABLE MACRO=…). */
  readonly name: string;
  readonly alias: string;
  readonly rename?: ConfigOption;
  /** Variables : nom (en minuscules, comme Klipper) → option. */
  readonly variables: ReadonlyMap<string, ConfigOption>;
}

interface Call {
  readonly from: string;
  readonly to: string;
  readonly template: MacroTemplate;
  readonly line: number;
}

class MacroChecker {
  readonly issues: MacroCheckIssue[] = [];
  private readonly macros: Macro[] = [];
  private readonly byAlias = new Map<string, Macro>();
  private readonly byName = new Map<string, Macro>();
  private readonly delayed = new Set<string>();
  private readonly sectionNames: Set<string>;
  private readonly calls: Call[] = [];
  /** Sections inconnues du firmware (modules installés à part) : commandes non recensées. */
  private readonly foreign: boolean;
  private readonly certain = new Set<string>();
  private readonly known: (command: string) => boolean;

  constructor(
    private readonly sections: readonly ConfigSection[],
    private readonly schema: ConfigSchema,
    private readonly firmware: FirmwareId,
    private readonly partial: boolean,
  ) {
    this.sectionNames = new Set(sections.map((s) => pyStrip(s.name)));
    const rules = schema.rules.map((rule) => new RegExp(rule.regex));
    const modules = new Set([...schema.modules.exact, ...schema.modules.prefix]);
    this.foreign = sections.some((section) => {
      const prefix = pySplit(section.name)[0] ?? "";
      return !modules.has(prefix) && !rules.some((rule) => rule.test(section.name));
    });
    const commands = schema.commands;
    const possible = new Set<string>(commands?.alwaysPossible ?? []);
    const patterns: RegExp[] = [];
    for (const name of commands?.always ?? []) this.certain.add(name);
    for (const section of sections) {
      const prefix = pySplit(section.name)[0] ?? "";
      for (const name of commands?.sections[prefix] ?? []) this.certain.add(name);
      for (const name of commands?.possible[prefix] ?? []) possible.add(name);
      for (const pattern of commands?.patterns[prefix] ?? []) patterns.push(new RegExp(pattern));
    }
    this.known = (command) =>
      this.certain.has(command) || possible.has(command) || patterns.some((p) => p.test(command));
  }

  private report(issue: MacroCheckIssue): void {
    this.issues.push(issue);
  }

  run(): void {
    this.collect();
    this.registerCommands();
    if (!this.schema.commands) return;
    for (const template of macroTemplates(this.sections, this.schema, this.firmware)) {
      this.checkTemplate(template);
    }
    this.checkRecursion();
  }

  /** Macros et `delayed_gcode` : noms, variables. */
  private collect(): void {
    for (const section of this.sections) {
      const words = pySplit(section.name);
      if (words[0] === "delayed_gcode" && words[1]) this.delayed.add(words[1]);
      if (words[0] !== "gcode_macro" || words.length < 2) continue;
      const at = { section: section.name, file: section.file, line: section.line };
      if (words.length > 2) {
        this.report({ code: "macro.name-whitespace", severity: "error", ...at });
        continue;
      }
      const name = words[1] ?? "";
      const alias = name.toUpperCase();
      const rename = section.options.get("rename_existing");
      const variables = new Map<string, ConfigOption>();
      for (const option of section.options.values()) {
        if (!option.name.startsWith("variable_")) continue;
        variables.set(option.name.slice("variable_".length), option);
        const problem = checkMacroLiteral(option.value);
        if (problem) {
          this.report({
            code: "macro.variable-literal",
            severity: "error",
            ...at,
            option: option.name,
            file: option.file,
            line: option.line,
            params: { variable: option.name, problem, value: option.value.trim() },
          });
        }
      }
      if (!registrable(alias)) {
        this.report({
          code: "macro.invalid-name",
          severity: "error",
          ...at,
          params: { command: alias },
        });
      }
      if (rename && isTraditionalGcode(alias) !== isTraditionalGcode(rename.value)) {
        this.report({
          code: "macro.rename-type",
          severity: "error",
          ...at,
          option: "rename_existing",
          file: rename.file,
          line: rename.line,
          params: { command: alias, rename: rename.value },
        });
      }
      const macro: Macro = { section, name, alias, ...(rename ? { rename } : {}), variables };
      this.macros.push(macro);
      this.byAlias.set(alias, macro);
      this.byName.set(name, macro);
    }
  }

  /**
   * Enregistrement des commandes comme Klipper : macros sans rename_existing à leur chargement,
   * puis, à la connexion et dans l'ordre, celles qui renomment une commande existante.
   */
  private registerCommands(): void {
    const commands = this.schema.commands;
    const registered = new Map<string, string>();
    for (const macro of this.macros) {
      if (macro.rename) continue;
      const at = {
        section: macro.section.name,
        file: macro.section.file,
        line: macro.section.line,
      };
      const other = registered.get(macro.alias);
      if (other !== undefined || (commands && this.certain.has(macro.alias))) {
        this.report({
          code: "macro.command-exists",
          severity: "error",
          ...at,
          params: { command: macro.alias, other: other ?? "" },
        });
      } else registered.set(macro.alias, macro.section.name);
    }
    for (const macro of this.macros) {
      const rename = macro.rename;
      // Types différents : Klipper s'arrête dès le chargement (macro.rename-type).
      if (!rename || isTraditionalGcode(macro.alias) !== isTraditionalGcode(rename.value)) continue;
      const at = {
        section: macro.section.name,
        option: "rename_existing",
        file: rename.file,
        line: rename.line,
      };
      const exists =
        registered.has(macro.alias) || this.certain.has(macro.alias) || this.known(macro.alias);
      if (commands && !exists && !this.partial) {
        this.report({
          code: "macro.rename-missing",
          // Un module installé à part peut fournir la commande : à vérifier seulement.
          severity: this.foreign ? "warning" : "error",
          ...at,
          params: { command: macro.alias },
        });
      }
      const target = rename.value;
      if (!registrable(target)) {
        this.report({
          code: "macro.rename-invalid-name",
          severity: "error",
          ...at,
          params: { command: target },
        });
      } else if (registered.has(target) || this.certain.has(target)) {
        this.report({
          code: "macro.rename-taken",
          severity: "error",
          ...at,
          params: { command: target, other: registered.get(target) ?? "" },
        });
      } else registered.set(target, macro.section.name);
      registered.set(macro.alias, macro.section.name);
    }
  }

  private checkTemplate(template: MacroTemplate): void {
    const env = jinjaEnvironment(this.firmware);
    const body = parseTemplate(template.source, env);
    const lines = templateLines(template.source, env);
    if (!body || !lines) return;
    const words = pySplit(template.section);
    const macro =
      words[0] === "gcode_macro" && template.option.name === "gcode"
        ? this.byName.get(words[1] ?? "")
        : undefined;
    const at = (line: number) => ({
      section: template.section,
      option: template.option.name,
      file: template.option.file,
      line: fileLineOf(template, line),
    });
    this.checkExpressions(body, macro, at);
    // Seuls les scripts G-code sont des commandes ; textes d'écran et de menu (text, name…) non.
    const option = template.option.name;
    if (option !== "gcode" && !option.endsWith("_gcode")) return;
    for (const { text, line } of lines) {
      const parsed = klipperCommand(text);
      if (!parsed) continue;
      this.checkCommand(parsed, macro, template, line, at(line));
    }
  }

  /** `params`, `printer[…]` et variables des macros, dans les expressions du modèle. */
  private checkExpressions(
    body: Node[],
    macro: Macro | undefined,
    at: (line: number) => Omit<MacroCheckIssue, "code" | "severity">,
  ): void {
    const parents = new Map<Node, Node>();
    const all: Node[] = [];
    const walk = (node: Node) => {
      all.push(node);
      for (const child of children(node)) {
        parents.set(child, node);
        walk(child);
      }
    };
    for (const node of body) walk(node);

    const text = (node: Expr | undefined) => (node?.kind === "const" ? node.text : undefined);
    const isName = (node: Node | undefined, name: string) =>
      node?.kind === "name" && node.name === name;
    /** Clé lue sur `objet` : `objet.clé`, `objet['clé']`. */
    const keyOf = (node: Node, object: (n: Expr) => boolean): string | undefined => {
      if (node.kind === "getattr" && object(node.node)) return node.attr;
      if (node.kind === "getitem" && object(node.node)) return text(node.arg);
      return undefined;
    };
    /** Objet de l'imprimante désigné par le nœud (`printer["nom"]`, `printer.nom`). */
    const printerObject = (node: Node | undefined) => {
      const key = node ? keyOf(node, (n) => isName(n, "printer")) : undefined;
      return key === undefined ? undefined : pyStrip(key);
    };
    /** Désignation gardable : `params:X`, `printer:nom`, `nom:variable`. */
    const guardKey = (node: Expr): string | undefined => {
      const param = keyOf(node, (n) => isName(n, "params"));
      if (param !== undefined) return `params:${param}`;
      const object = printerObject(node);
      if (object !== undefined) return `printer:${object}`;
      const parent =
        node.kind === "getattr" || node.kind === "getitem" ? printerObject(node.node) : undefined;
      const field = parent === undefined ? undefined : keyOf(node, () => true);
      return field === undefined ? undefined : `${parent}:${field}`;
    };
    // Gardes : `'X' in params`, `'v' in printer['gcode_macro M']`, `… is defined`, `…|default(…)`.
    const guarded = new Set<string>();
    for (const node of all) {
      if (node.kind === "compare") {
        node.operators.forEach((operator, index) => {
          const key = text(index === 0 ? node.expr : node.ops[index - 1]);
          const container = node.ops[index];
          if ((operator !== "in" && operator !== "notin") || key === undefined || !container)
            return;
          if (container.kind === "name") guarded.add(`${container.name}:${key}`);
          const object = printerObject(container);
          if (object !== undefined) guarded.add(`${object}:${key}`);
        });
      }
      // `{% if params.X %}` : une valeur indéfinie testée vaut faux, sans erreur.
      const conditions =
        node.kind === "if"
          ? [node.test, ...node.elifs.map((e) => e.test)]
          : node.kind === "condexpr"
            ? [node.test]
            : [];
      for (const condition of conditions) {
        const inside: Node[] = [condition];
        for (let i = 0; i < inside.length; i++) inside.push(...children(inside[i] as Node));
        for (const part of inside) {
          const param = keyOf(part, (n) => isName(n, "params"));
          if (param !== undefined) guarded.add(`params:${param}`);
        }
      }
      const defaulted =
        (node.kind === "test" && (node.name === "defined" || node.name === "undefined")) ||
        (node.kind === "filter" && (node.name === "default" || node.name === "d"));
      const target = node.kind === "test" || node.kind === "filter" ? node.node : undefined;
      const key = defaulted && target ? guardKey(target) : undefined;
      if (key !== undefined && !(node.kind === "filter" && key.startsWith("params:")))
        guarded.add(key);
    }

    const reported = new Set<string>();
    for (const node of all) {
      // Paramètres de la commande : clés toujours en majuscules (gcode.py).
      if (macro) {
        const direct = keyOf(node, (n) => isName(n, "params"));
        const parent = parents.get(node);
        const viaGet =
          node.kind === "call" &&
          node.node.kind === "getattr" &&
          node.node.attr === "get" &&
          isName(node.node.node, "params")
            ? text(node.args.args[0])
            : undefined;
        const key = direct ?? viaGet;
        if (
          key !== undefined &&
          !(direct !== undefined && parent?.kind === "call" && direct === "get")
        ) {
          if (key !== key.toUpperCase() && !reported.has(`case:${key}`)) {
            reported.add(`case:${key}`);
            this.report({
              code: "macro.param-case",
              severity: "warning",
              ...at(node.line),
              params: { param: key, upper: key.toUpperCase() },
            });
          } else if (
            direct !== undefined &&
            key === key.toUpperCase() &&
            !guarded.has(`params:${key}`) &&
            !(parent?.kind === "filter" && (parent.name === "default" || parent.name === "d")) &&
            !reported.has(`default:${key}`)
          ) {
            reported.add(`default:${key}`);
            this.report({
              code: "macro.param-default",
              severity: "info",
              ...at(node.line),
              params: { param: key },
            });
          }
        }
      }
      // Objets de l'imprimante : `printer["gcode_macro X"]`, sections nommées.
      const name = printerObject(node);
      if (name === undefined || guarded.has(`printer:${name}`)) continue;
      const prefix = pySplit(name)[0] ?? "";
      if (pySplit(name).length < 2 || !this.schema.modules.prefix.includes(prefix)) continue;
      const parent = parents.get(node);
      const variable =
        parent && (parent.kind === "getattr" || parent.kind === "getitem")
          ? keyOf(parent, (n) => n === node)
          : undefined;
      if (!this.sectionNames.has(name)) {
        // Objet absent : valeur indéfinie (getitem de Jinja) ; l'erreur vient de la lecture d'un champ.
        if (variable === undefined || this.partial || reported.has(`object:${name}`)) continue;
        reported.add(`object:${name}`);
        const suggestion = [...this.sectionNames].find(
          (s) => s.toLowerCase() === name.toLowerCase(),
        );
        this.report({
          code: "macro.unknown-object",
          severity: "warning",
          ...at(node.line),
          params: { object: name, suggestion: suggestion ?? "none" },
        });
        continue;
      }
      // Variable d'une autre macro : `printer["gcode_macro X"].variable`.
      const target = prefix === "gcode_macro" ? this.byName.get(pySplit(name)[1] ?? "") : undefined;
      if (!target || variable === undefined || variable === "get" || target.variables.has(variable))
        continue;
      if (guarded.has(`${name}:${variable}`) || reported.has(`variable:${name}:${variable}`))
        continue;
      reported.add(`variable:${name}:${variable}`);
      const suggestion = target.variables.has(variable.toLowerCase())
        ? variable.toLowerCase()
        : "none";
      this.report({
        code: "macro.unknown-variable",
        severity: "warning",
        ...at(node.line),
        params: { variable, macro: target.name, suggestion },
      });
    }
  }

  private checkCommand(
    parsed: NonNullable<ReturnType<typeof klipperCommand>>,
    macro: Macro | undefined,
    template: MacroTemplate,
    line: number,
    at: Omit<MacroCheckIssue, "code" | "severity">,
  ): void {
    let { command } = parsed;
    if (command.includes(EXPRESSION_MARK)) return;
    // M117/M118/M23 suivis de texte : « M117 5 » est traité comme M117 (cmd_default).
    if (command.includes(" ")) {
      const real = command.split(" ")[0] ?? "";
      if (["M117", "M118", "M23"].includes(real) && (this.known(real) || this.byAlias.has(real)))
        command = real;
    }
    const callee = this.byAlias.get(command);
    if (callee) {
      if (macro) this.calls.push({ from: macro.alias, to: callee.alias, template, line });
    } else if (
      !this.known(command) &&
      !silentlyIgnored(command, parsed.params) &&
      !this.isRenamed(command)
    ) {
      // Section ou option tombée dans le script (indentation) : Klipper ne la lit pas comme réglage.
      if (/^\[[^\]]*\]?\s*$|^[A-Za-z_]\w*\s*[:=]/.test(parsed.raw)) {
        this.report({
          code: "macro.config-line",
          severity: "warning",
          ...at,
          params: { text: parsed.raw.slice(0, 60) },
        });
      } else if (!this.partial && this.schema.commands) {
        this.report({
          code: "macro.unknown-command",
          severity: this.foreign ? "info" : "warning",
          ...at,
          params: { command },
        });
      }
      return;
    }
    if (command === "SET_GCODE_VARIABLE") this.checkSetVariable(parsed.raw, at);
    if (command === "UPDATE_DELAYED_GCODE") {
      const id = extendedParams(parsed.raw, command)?.["ID"];
      if (
        id !== undefined &&
        !id.includes(EXPRESSION_MARK) &&
        !this.delayed.has(id) &&
        !this.partial
      ) {
        this.report({
          code: "macro.delayed-gcode-unknown",
          severity: "warning",
          ...at,
          params: { id },
        });
      }
    }
  }

  /** Commande libérée par rename_existing (appelable telle qu'elle est écrite, en majuscules). */
  private isRenamed(command: string): boolean {
    return this.macros.some((m) => m.rename?.value === command);
  }

  private checkSetVariable(raw: string, at: Omit<MacroCheckIssue, "code" | "severity">): void {
    const params = extendedParams(raw, "SET_GCODE_VARIABLE");
    const name = params?.["MACRO"];
    if (!params || name === undefined || name.includes(EXPRESSION_MARK)) return;
    const target = this.byName.get(name);
    if (!target) {
      if (this.partial) return;
      const suggestion = [...this.byName.keys()].find(
        (n) => n.toLowerCase() === name.toLowerCase(),
      );
      this.report({
        code: "macro.set-variable-macro",
        severity: "warning",
        ...at,
        params: { macro: name, suggestion: suggestion ?? "none" },
      });
      return;
    }
    const variable = params["VARIABLE"];
    if (
      variable !== undefined &&
      !variable.includes(EXPRESSION_MARK) &&
      !target.variables.has(variable)
    ) {
      const suggestion = target.variables.has(variable.toLowerCase())
        ? variable.toLowerCase()
        : "none";
      this.report({
        code: "macro.set-variable-unknown",
        severity: "warning",
        ...at,
        params: { variable, macro: name, suggestion },
      });
    }
    const value = params["VALUE"];
    if (value !== undefined && !value.includes(EXPRESSION_MARK)) {
      const problem = checkMacroLiteral(value);
      if (problem) {
        this.report({
          code: "macro.set-variable-value",
          severity: "warning",
          ...at,
          params: { value, problem },
        });
      }
    }
  }

  /** Appels qui reviennent à la macro appelante : « Macro X called recursively ». */
  private checkRecursion(): void {
    const edges = new Map<string, Set<string>>();
    for (const call of this.calls) {
      if (!edges.has(call.from)) edges.set(call.from, new Set());
      edges.get(call.from)?.add(call.to);
    }
    const reaches = (from: string, target: string) => {
      const seen = new Set<string>();
      const todo = [from];
      while (todo.length > 0) {
        const current = todo.pop() ?? "";
        if (current === target) return true;
        if (seen.has(current)) continue;
        seen.add(current);
        todo.push(...(edges.get(current) ?? []));
      }
      return false;
    };
    const reported = new Set<string>();
    for (const call of this.calls) {
      const key = `${call.from}>${call.to}`;
      if (reported.has(key) || !reaches(call.to, call.from)) continue;
      reported.add(key);
      this.report({
        code: "macro.recursive",
        severity: "warning",
        section: call.template.section,
        option: call.template.option.name,
        file: call.template.option.file,
        line: fileLineOf(call.template, call.line),
        params: { macro: call.from, callee: call.to },
      });
    }
  }
}

/** Vérifie le sens des macros de la configuration, pour le firmware donné. */
export function checkMacros(
  sections: readonly ConfigSection[],
  schema: ConfigSchema,
  firmware: FirmwareId,
  options: MacroCheckOptions = {},
): MacroCheckIssue[] {
  const checker = new MacroChecker(sections, schema, firmware, options.partial ?? false);
  checker.run();
  return checker.issues;
}
