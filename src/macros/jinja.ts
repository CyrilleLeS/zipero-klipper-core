// SPDX-License-Identifier: GPL-3.0-only
//
// Lint des modèles Jinja des macros (EP-06.07). Reproduit, pour les signaler AVANT le démarrage de
// l'imprimante, les erreurs que Jinja lève en compilant un modèle : Klipper compile tous ses modèles
// au démarrage et refuse de démarrer à la première erreur (klippy/extras/gcode_macro.py).
//
// Portage du lexique, de la grammaire et des contrôles de compilation de Jinja2 (Pallets), dans les
// deux versions en service : 2.11.3 (Klipper et forks : scripts/klippy-requirements.txt) et 3.1.6
// avec les extensions `do` et `loopcontrols` (Kalico). Mêmes messages, mêmes lignes et même ordre
// de découverte que Jinja : vérifié contre le vrai Jinja sur le corpus et des cas limites
// (tooling/corpus-tests, oracle harvest/jinja_oracle.py).
//
// Jinja2 : Copyright 2007 Pallets. Redistribution and use in source and binary forms, with or
// without modification, are permitted provided that the following conditions are met:
// 1. Redistributions of source code must retain the above copyright notice, this list of
//    conditions and the following disclaimer.
// 2. Redistributions in binary form must reproduce the above copyright notice, this list of
//    conditions and the following disclaimer in the documentation and/or other materials provided
//    with the distribution.
// 3. Neither the name of the copyright holder nor the names of its contributors may be used to
//    endorse or promote products derived from this software without specific prior written
//    permission.
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR
// IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND
// FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR
// CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
// DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
// DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
// WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY
// WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
//
// Limites connues (constructions sans usage dans une macro) : noms Unicode de `\N{…}` non vérifiés ;
// repliement de constantes limité aux littéraux, `not`, `and`, `or` et `… if … else …`.

import type { FirmwareId } from "../config/firmwares";

export const JINJA_CODES = [
  "jinja.syntax",
  "jinja.unexpected-end",
  "jinja.unexpected-char",
  "jinja.unbalanced",
  "jinja.unclosed-block",
  "jinja.unexpected-tag",
  "jinja.unknown-tag",
  "jinja.unknown-filter",
  "jinja.unknown-test",
  "jinja.unclosed-comment",
  "jinja.unclosed-raw",
  "jinja.double-brace",
  "jinja.loop-control",
] as const;

export type JinjaCode = (typeof JINJA_CODES)[number];

export interface JinjaIssue {
  readonly code: JinjaCode;
  /** Ligne du modèle (à partir de 1) à montrer : l'ouverture d'un bloc non fermé, sinon l'erreur. */
  readonly line: number;
  /** Ligne rapportée par Jinja (journal de Klipper) ; absente pour une erreur du code Python généré. */
  readonly jinjaLine?: number;
  /** Message de Jinja, tel que Klipper l'affiche. */
  readonly message: string;
  /** true : Klipper refuse de démarrer ; false : erreur seulement à l'exécution de la macro. */
  readonly startup: boolean;
  readonly params?: Readonly<Record<string, string>>;
}

export interface JinjaEnvironment {
  readonly version: "2.11.3" | "3.1.6";
  readonly extensions: readonly ("do" | "loopcontrols")[];
  readonly filters: ReadonlySet<string>;
  readonly tests: ReadonlySet<string>;
}

const FILTERS_2_11 = [
  "abs",
  "attr",
  "batch",
  "capitalize",
  "center",
  "count",
  "d",
  "default",
  "dictsort",
  "e",
  "escape",
  "filesizeformat",
  "first",
  "float",
  "forceescape",
  "format",
  "groupby",
  "indent",
  "int",
  "join",
  "last",
  "length",
  "list",
  "lower",
  "map",
  "max",
  "min",
  "pprint",
  "random",
  "reject",
  "rejectattr",
  "replace",
  "reverse",
  "round",
  "safe",
  "select",
  "selectattr",
  "slice",
  "sort",
  "string",
  "striptags",
  "sum",
  "title",
  "tojson",
  "trim",
  "truncate",
  "unique",
  "upper",
  "urlencode",
  "urlize",
  "wordcount",
  "wordwrap",
  "xmlattr",
];

const TESTS_2_11 = [
  "!=",
  "<",
  "<=",
  "==",
  ">",
  ">=",
  "boolean",
  "callable",
  "defined",
  "divisibleby",
  "eq",
  "equalto",
  "escaped",
  "even",
  "false",
  "float",
  "ge",
  "greaterthan",
  "gt",
  "in",
  "integer",
  "iterable",
  "le",
  "lessthan",
  "lower",
  "lt",
  "mapping",
  "ne",
  "none",
  "number",
  "odd",
  "sameas",
  "sequence",
  "string",
  "true",
  "undefined",
  "upper",
];

/** Environnements Jinja des firmwares (gcode_macro.py de chacun, vérifiés à l'étape 21). */
export const JINJA_ENVIRONMENTS = {
  klipper: {
    version: "2.11.3",
    extensions: [],
    filters: new Set(FILTERS_2_11),
    tests: new Set(TESTS_2_11),
  },
  kalico: {
    version: "3.1.6",
    extensions: ["do", "loopcontrols"],
    filters: new Set([...FILTERS_2_11, "items"]),
    tests: new Set([...TESTS_2_11, "filter", "test"]),
  },
} as const satisfies Record<string, JinjaEnvironment>;

/** Kalico : Jinja 3.1 avec `do`, `break` et `continue` ; les autres : l'environnement de Klipper. */
export function jinjaEnvironment(firmware: FirmwareId): JinjaEnvironment {
  return firmware === "kalico" ? JINJA_ENVIRONMENTS.kalico : JINJA_ENVIRONMENTS.klipper;
}

// ---------------------------------------------------------------------------------------------
// Erreurs

class JinjaFailure extends Error {
  constructor(
    readonly code: JinjaCode,
    readonly jinjaLine: number,
    message: string,
    readonly params: Record<string, string> = {},
    readonly line = jinjaLine,
  ) {
    super(message);
  }
}

/** Levée par Jinja pour abandonner la génération du reste d'une liste d'instructions. */
class CompilerExit extends Error {}

/** `repr()` de Python pour une chaîne (messages de Jinja). */
function pyRepr(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = quote;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (char === quote || char === "\\") out += `\\${char}`;
    else if (char === "\n") out += "\\n";
    else if (char === "\r") out += "\\r";
    else if (char === "\t") out += "\\t";
    else if (char !== " " && /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u.test(char)) {
      const hex = code.toString(16);
      out +=
        code <= 0xff
          ? `\\x${hex.padStart(2, "0")}`
          : code <= 0xffff
            ? `\\u${hex.padStart(4, "0")}`
            : `\\U${hex.padStart(8, "0")}`;
    } else out += char;
  }
  return out + quote;
}

// ---------------------------------------------------------------------------------------------
// Lexique (jinja2/lexer.py)

/** Blancs au sens de Python (`\s`, `str.isspace`). */
const PY_SPACE =
  "[\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
const PY_TRAILING_SPACE = new RegExp(`${PY_SPACE}+$`, "u");
const WHITESPACE = new RegExp(`${PY_SPACE}+`, "uy");
const FLOAT =
  /(?<!\.)(?:\p{Nd}+_)*\p{Nd}+(?:(?:\.(?:\p{Nd}+_)*\p{Nd}+)?[eE][+-]?(?:\p{Nd}+_)*\p{Nd}+|\.(?:\p{Nd}+_)*\p{Nd}+)/uy;
const INTEGER_2 = /(?:\p{Nd}+_)*\p{Nd}+/uy;
const INTEGER_3 =
  /(?:0[bB](?:_?[01])+|0[oO](?:_?[0-7])+|0[xX](?:_?[\p{Nd}a-fA-F])+|[1-9](?:_?\p{Nd})*|0(?:_?0)*)/uy;
/** `\w` de Python et les caractères de continuation d'identifiant (jinja2/_identifier.py). */
const NAME = /[\p{L}\p{N}\p{XID_Continue}]+/uy;
const IDENTIFIER = /^[\p{XID_Start}_]\p{XID_Continue}*$/u;
const STRING = /'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)"/sy;

const OPERATORS: Readonly<Record<string, string>> = {
  "+": "add",
  "-": "sub",
  "/": "div",
  "//": "floordiv",
  "*": "mul",
  "%": "mod",
  "**": "pow",
  "~": "tilde",
  "[": "lbracket",
  "]": "rbracket",
  "(": "lparen",
  ")": "rparen",
  "{": "lbrace",
  "}": "rbrace",
  "==": "eq",
  "!=": "ne",
  ">": "gt",
  ">=": "gteq",
  "<": "lt",
  "<=": "lteq",
  "=": "assign",
  ".": "dot",
  ":": "colon",
  "|": "pipe",
  ",": "comma",
  ";": "semicolon",
};
const REVERSE_OPERATORS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(OPERATORS).map(([text, type]) => [type, text]),
);
const OPERATOR_TEXTS = Object.keys(OPERATORS).sort((a, b) => b.length - a.length);

interface Token {
  readonly type: string;
  readonly value: string;
  readonly line: number;
  /** Position dans le source normalisé (−1 pour la fin). */
  readonly start: number;
}

const countNewlines = (text: string) => {
  let count = 0;
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) count += 1;
  return count;
};

/**
 * Fins de ligne comme Jinja : 2.11 découpe avec `str.splitlines()` (toutes les fins de ligne
 * Unicode), 3.x seulement sur \r\n, \r et \n ; la dernière fin de ligne est retirée.
 */
function normalizeSource(source: string, env: JinjaEnvironment): string {
  const lines = source.split(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: fins de ligne de str.splitlines() (Python)
    env.version === "2.11.3" ? /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/ : /\r\n|\r|\n/,
  );
  if (lines.at(-1) === "") lines.pop();
  return lines.join("\n");
}

/**
 * Contrôle d'une chaîne comme `str.encode("ascii", "backslashreplace").decode("unicode-escape")`
 * (appelé par Jinja sur chaque chaîne) : message d'erreur de Python ou longueur décodée.
 */
const OCTAL = /^[0-7]$/;

function decodeString(raw: string): { readonly error?: string; readonly empty: boolean } {
  let text = "";
  for (const char of raw.replace(/\r\n|\r/g, "\n")) {
    const code = char.codePointAt(0) ?? 0;
    const hex = code.toString(16);
    text +=
      code < 0x80
        ? char
        : code <= 0xff
          ? `\\x${hex.padStart(2, "0")}`
          : code <= 0xffff
            ? `\\u${hex.padStart(4, "0")}`
            : `\\U${hex.padStart(8, "0")}`;
  }
  let produced = 0;
  const hexRun = (at: number, count: number) =>
    /^[0-9a-fA-F]+$/.test(text.slice(at, at + count)) && text.length >= at + count;
  for (let i = 0; i < text.length; ) {
    if (text[i] !== "\\") {
      produced += 1;
      i += 1;
      continue;
    }
    const kind = text[i + 1];
    i += 2;
    if (kind === undefined) return { error: "\\ at end of string", empty: false };
    if (kind === "\n") continue;
    if ("\\'\"abfnrtv".includes(kind)) produced += 1;
    else if (OCTAL.test(kind)) {
      for (let n = 0; n < 2 && OCTAL.test(text[i] ?? ""); n++) i += 1;
      produced += 1;
    } else if (kind === "x" || kind === "u" || kind === "U") {
      const size = { x: 2, u: 4, U: 8 }[kind];
      if (!hexRun(i, size)) {
        return { error: `truncated \\${kind}${"X".repeat(size)} escape`, empty: false };
      }
      if (kind === "U" && Number.parseInt(text.slice(i, i + 8), 16) > 0x10ffff) {
        return { error: "illegal Unicode character", empty: false };
      }
      i += size;
      produced += 1;
    } else if (kind === "N") {
      const close = text.indexOf("}", i);
      if (text[i] !== "{" || close < i + 2)
        return { error: "malformed \\N character escape", empty: false };
      i = close + 1;
      produced += 1;
    } else produced += 2;
  }
  return { empty: produced === 0 };
}

/** Jetons produits à la demande, comme `Lexer.tokeniter` + `Lexer.wrap` : une erreur n'est levée qu'une fois le jeton atteint. */
function* tokenize(text: string, env: JinjaEnvironment): Generator<Token, void, undefined> {
  const source = normalizeSource(text, env);
  const v3 = env.version !== "2.11.3";
  const rawBegin = new RegExp(
    `\\{%(-|\\+|)${PY_SPACE}*raw${PY_SPACE}*(?:-%\\}${PY_SPACE}*|%\\})`,
    "uy",
  );
  const rawEnd = new RegExp(
    `\\{%(-|\\+|)${PY_SPACE}*endraw${PY_SPACE}*(?:${v3 ? "\\+%\\}|" : ""}-%\\}${PY_SPACE}*|%\\})`,
    "gu",
  );
  const commentEnd = new RegExp(`(?:${v3 ? "\\+#\\}|" : ""}-#\\}${PY_SPACE}*|#\\})`, "gu");
  const blockEnd = new RegExp(`(?:${v3 ? "\\+%\\}|" : ""}-%\\}${PY_SPACE}*|%\\})`, "uy");
  const variableEnd = new RegExp(`-\\}${PY_SPACE}*|\\}`, "uy");
  const integer = v3 ? INTEGER_3 : INTEGER_2;
  const length = source.length;
  let pos = 0;
  let line = 1;
  const fail = (code: JinjaCode, message: string, params?: Record<string, string>): never => {
    throw new JinjaFailure(code, line, message, params);
  };

  while (pos < length) {
    // État racine : texte jusqu'à la première balise.
    const brace = source.indexOf("{", pos);
    if (brace < 0) {
      yield { type: "data", value: source.slice(pos), line, start: pos };
      return;
    }
    let kind: "raw" | "comment" | "block" | "variable";
    let sign: string;
    let tagEnd: number;
    rawBegin.lastIndex = brace;
    const raw = rawBegin.exec(source);
    if (raw) {
      kind = "raw";
      sign = raw[1] ?? "";
      tagEnd = rawBegin.lastIndex;
    } else {
      const second = source[brace + 1];
      kind = second === "#" ? "comment" : second === "%" ? "block" : "variable";
      const after = brace + (kind === "variable" ? 1 : 2);
      sign = source[after] === "-" || source[after] === "+" ? (source[after] ?? "") : "";
      tagEnd = after + sign.length;
    }
    const before = source.slice(pos, brace);
    const data = sign === "-" ? before.replace(PY_TRAILING_SPACE, "") : before;
    if (data) yield { type: "data", value: data, line, start: pos };
    line += countNewlines(before);
    const tag = source.slice(brace, tagEnd);
    const tagLine = line;
    line += countNewlines(tag);
    pos = tagEnd;

    if (kind === "comment") {
      commentEnd.lastIndex = pos;
      const end = commentEnd.exec(source);
      if (!end) {
        if (pos < length) fail("jinja.unclosed-comment", "Missing end of comment tag");
        return;
      }
      line += countNewlines(source.slice(pos, commentEnd.lastIndex));
      pos = commentEnd.lastIndex;
      continue;
    }
    if (kind === "raw") {
      rawEnd.lastIndex = pos;
      const end = rawEnd.exec(source);
      if (!end) {
        if (pos < length) fail("jinja.unclosed-raw", "Missing end of raw directive");
        return;
      }
      const inside = source.slice(pos, end.index);
      const content = end[1] === "-" ? inside.replace(PY_TRAILING_SPACE, "") : inside;
      if (content) yield { type: "data", value: content, line, start: pos };
      line += countNewlines(source.slice(pos, rawEnd.lastIndex));
      pos = rawEnd.lastIndex;
      continue;
    }

    yield {
      type: kind === "block" ? "block_begin" : "variable_begin",
      value: tag,
      line: tagLine,
      start: brace,
    };
    // Dans la balise : fin reconnue seulement si les parenthèses sont équilibrées.
    const balancing: string[] = [];
    const endRule = kind === "block" ? blockEnd : variableEnd;
    for (;;) {
      if (balancing.length === 0) {
        endRule.lastIndex = pos;
        const end = endRule.exec(source);
        if (end) {
          yield {
            type: kind === "block" ? "block_end" : "variable_end",
            value: end[0],
            line,
            start: pos,
          };
          line += countNewlines(end[0]);
          pos = endRule.lastIndex;
          break;
        }
      }
      WHITESPACE.lastIndex = pos;
      const space = WHITESPACE.exec(source);
      if (space) {
        line += countNewlines(space[0]);
        pos = WHITESPACE.lastIndex;
        continue;
      }
      let token: Token | undefined;
      for (const [type, pattern] of [
        ["float", FLOAT],
        ["integer", integer],
        ["name", NAME],
        ["string", STRING],
      ] as const) {
        pattern.lastIndex = pos;
        const found = pattern.exec(source);
        if (found) {
          token = { type, value: found[0], line, start: pos };
          pos = pattern.lastIndex;
          break;
        }
      }
      if (!token) {
        const operator = OPERATOR_TEXTS.find((op) => source.startsWith(op, pos));
        if (operator === undefined) {
          if (pos >= length) return;
          const char = String.fromCodePoint(source.codePointAt(pos) ?? 0);
          fail(
            "jinja.unexpected-char",
            `unexpected char ${pyRepr(char)} at ${[...source.slice(0, pos)].length}`,
            { char },
          );
        } else {
          if (operator === "{" || operator === "(" || operator === "[") {
            balancing.push(operator === "{" ? "}" : operator === "(" ? ")" : "]");
          } else if (operator === "}" || operator === ")" || operator === "]") {
            const expected = balancing.pop();
            if (expected === undefined)
              fail("jinja.unbalanced", `unexpected '${operator}'`, { char: operator });
            else if (expected !== operator) {
              fail("jinja.unbalanced", `unexpected '${operator}', expected '${expected}'`, {
                char: operator,
                expected,
              });
            }
          }
          token = { type: OPERATORS[operator] ?? operator, value: operator, line, start: pos };
          pos += operator.length;
        }
      }
      if (!token) return;
      if (token.type === "name" && !IDENTIFIER.test(token.value)) {
        fail("jinja.syntax", "Invalid character in identifier");
      }
      if (token.type === "string") {
        const decoded = decodeString(token.value.slice(1, -1));
        if (decoded.error) fail("jinja.syntax", decoded.error);
      }
      yield token;
      line += countNewlines(token.value);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Flux de jetons (jinja2/lexer.py, TokenStream)

function describeType(type: string): string {
  return (
    REVERSE_OPERATORS[type] ??
    {
      block_begin: "begin of statement block",
      block_end: "end of statement block",
      variable_begin: "begin of print statement",
      variable_end: "end of print statement",
      data: "template data / text",
      eof: "end of template",
    }[type] ??
    type
  );
}

const describe = (token: Token) => (token.type === "name" ? token.value : describeType(token.type));

function describeExpr(expr: string): string {
  const colon = expr.indexOf(":");
  if (colon >= 0 && expr.slice(0, colon) === "name") return expr.slice(colon + 1);
  return describeType(colon >= 0 ? expr.slice(0, colon) : expr);
}

function test(token: Token, expr: string): boolean {
  if (token.type === expr) return true;
  const colon = expr.indexOf(":");
  return colon >= 0 && token.type === expr.slice(0, colon) && token.value === expr.slice(colon + 1);
}

class TokenStream {
  current: Token = { type: "initial", value: "", line: 1, start: 0 };
  private readonly pushed: Token[] = [];
  private exhausted = false;

  constructor(private readonly tokens: Iterator<Token, void, undefined>) {
    this.next();
  }

  get more(): boolean {
    return this.pushed.length > 0 || this.current.type !== "eof";
  }

  next(): Token {
    const rv = this.current;
    const pushed = this.pushed.shift();
    if (pushed) this.current = pushed;
    else if (this.current.type !== "eof") {
      const result = this.exhausted ? undefined : this.tokens.next();
      if (!result || result.done) {
        this.exhausted = true;
        this.current = { type: "eof", value: "", line: this.current.line, start: -1 };
      } else this.current = result.value;
    }
    return rv;
  }

  look(): Token {
    const old = this.next();
    const result = this.current;
    this.pushed.push(result);
    this.current = old;
    return result;
  }

  skip(count = 1): void {
    for (let i = 0; i < count; i++) this.next();
  }

  skipIf(expr: string): boolean {
    if (!test(this.current, expr)) return false;
    this.next();
    return true;
  }

  expect(expr: string): Token {
    if (!test(this.current, expr)) {
      const described = describeExpr(expr);
      if (this.current.type === "eof") {
        throw new JinjaFailure(
          "jinja.unexpected-end",
          this.current.line,
          `unexpected end of template, expected ${pyRepr(described)}.`,
        );
      }
      throw new JinjaFailure(
        "jinja.syntax",
        this.current.line,
        `expected token ${pyRepr(described)}, got ${pyRepr(describe(this.current))}`,
      );
    }
    return this.next();
  }
}

// ---------------------------------------------------------------------------------------------
// Arbre (jinja2/nodes.py, réduit à ce que les contrôles utilisent)

type Ctx = "load" | "store" | "param";

interface CallArgs {
  readonly args: Expr[];
  readonly kwargs: { readonly key: string; readonly value: Expr }[];
  readonly dynArgs: Expr | undefined;
  readonly dynKwargs: Expr | undefined;
}

type Expr =
  | { kind: "name"; name: string; ctx: Ctx; line: number }
  | { kind: "nsref"; name: string; line: number }
  | { kind: "const"; truthy: boolean; line: number }
  | { kind: "tuple"; items: Expr[]; ctx: Ctx; line: number }
  | { kind: "list"; items: Expr[]; line: number }
  | { kind: "dict"; items: { key: Expr; value: Expr }[]; line: number }
  | { kind: "condexpr"; test: Expr; expr1: Expr; expr2: Expr | undefined; line: number }
  | { kind: "binop"; op: string; left: Expr; right: Expr; line: number }
  | { kind: "unary"; op: "not" | "neg" | "pos"; node: Expr; line: number }
  | { kind: "compare"; expr: Expr; ops: Expr[]; line: number }
  | { kind: "concat"; nodes: Expr[]; line: number }
  | { kind: "getattr"; node: Expr; line: number }
  | { kind: "getitem"; node: Expr; arg: Expr; line: number }
  | { kind: "slice"; parts: (Expr | undefined)[]; line: number }
  | { kind: "call"; node: Expr; args: CallArgs; line: number }
  | { kind: "filter"; node: Expr | undefined; name: string; args: CallArgs; line: number }
  | { kind: "test"; node: Expr; name: string; args: CallArgs; line: number };

type Stmt =
  | { kind: "output"; nodes: Expr[]; line: number }
  | { kind: "extends"; template: Expr; line: number }
  | {
      kind: "for";
      target: Expr;
      iter: Expr;
      body: Stmt[];
      else_: Stmt[];
      test: Expr | undefined;
      recursive: boolean;
      line: number;
    }
  | {
      kind: "if";
      test: Expr;
      body: Stmt[];
      elifs: { test: Expr; body: Stmt[] }[];
      else_: Stmt[];
      line: number;
    }
  | { kind: "macro"; args: Expr[]; defaults: Expr[]; body: Stmt[]; line: number }
  | { kind: "callblock"; call: Expr; args: Expr[]; defaults: Expr[]; body: Stmt[]; line: number }
  | { kind: "filterblock"; filter: Expr; body: Stmt[]; line: number }
  | { kind: "with"; targets: Expr[]; values: Expr[]; body: Stmt[]; line: number }
  | { kind: "block"; name: string; body: Stmt[]; line: number }
  | { kind: "include" | "import" | "fromimport"; template: Expr; line: number }
  | { kind: "exprstmt"; node: Expr; line: number }
  | { kind: "assign"; target: Expr; node: Expr; line: number }
  | { kind: "assignblock"; target: Expr; filter: Expr | undefined; body: Stmt[]; line: number }
  | { kind: "scope"; option: Expr; body: Stmt[]; line: number }
  | { kind: "break" | "continue"; line: number };

type Node = Expr | Stmt;

/** Enfants dans l'ordre des champs de Jinja (`iter_child_nodes`), pour `find_all`. */
function children(node: Node): Node[] {
  const call = (a: CallArgs) => [
    ...a.args,
    ...a.kwargs.map((k) => k.value),
    ...(a.dynArgs ? [a.dynArgs] : []),
    ...(a.dynKwargs ? [a.dynKwargs] : []),
  ];
  switch (node.kind) {
    case "tuple":
    case "list":
      return node.items;
    case "dict":
      return node.items.flatMap((p) => [p.key, p.value]);
    case "condexpr":
      return [node.test, node.expr1, ...(node.expr2 ? [node.expr2] : [])];
    case "binop":
      return [node.left, node.right];
    case "unary":
      return [node.node];
    case "compare":
      return [node.expr, ...node.ops];
    case "concat":
    case "output":
      return node.nodes;
    case "getattr":
      return [node.node];
    case "getitem":
      return [node.node, node.arg];
    case "slice":
      return node.parts.filter((p): p is Expr => p !== undefined);
    case "call":
      return [node.node, ...call(node.args)];
    case "filter":
      return [...(node.node ? [node.node] : []), ...call(node.args)];
    case "test":
      return [node.node, ...call(node.args)];
    case "extends":
    case "include":
    case "import":
    case "fromimport":
      return [node.template];
    case "for":
      return [
        node.target,
        node.iter,
        ...node.body,
        ...node.else_,
        ...(node.test ? [node.test] : []),
      ];
    case "if":
      return [
        node.test,
        ...node.body,
        ...node.elifs.flatMap((e) => [e.test, ...e.body]),
        ...node.else_,
      ];
    case "macro":
      return [...node.args, ...node.defaults, ...node.body];
    case "callblock":
      return [node.call, ...node.args, ...node.defaults, ...node.body];
    case "filterblock":
      return [...node.body, node.filter];
    case "with":
      return [...node.targets, ...node.values, ...node.body];
    case "block":
      return node.body;
    case "exprstmt":
      return [node.node];
    case "assign":
      return [node.target, node.node];
    case "assignblock":
      return [node.target, ...(node.filter ? [node.filter] : []), ...node.body];
    case "scope":
      return [node.option, ...node.body];
    default:
      return [];
  }
}

function* findAll(nodes: readonly Node[], stopAtBlocks = false): Generator<Node> {
  for (const node of nodes) {
    yield node;
    if (!(stopAtBlocks && node.kind === "block")) yield* findAll(children(node), stopAtBlocks);
  }
}

function setCtx(node: Expr, ctx: Ctx): void {
  if (node.kind === "name" || node.kind === "tuple") node.ctx = ctx;
  for (const child of children(node)) if (child.kind !== "output") setCtx(child as Expr, ctx);
}

function canAssign(node: Expr): boolean {
  if (node.kind === "name")
    return !["true", "false", "none", "True", "False", "None"].includes(node.name);
  if (node.kind === "nsref") return true;
  if (node.kind === "tuple") return node.items.every(canAssign);
  return false;
}

/** Nom de la classe de nœud de Jinja, en minuscules (messages « can't assign to … »). */
const nodeClass = (node: Expr) =>
  node.kind === "binop" || node.kind === "unary" ? node.op : node.kind;

// ---------------------------------------------------------------------------------------------
// Grammaire (jinja2/parser.py)

const COMPARE_OPERATORS = new Set(["eq", "ne", "lt", "lteq", "gt", "gteq"]);
/** Balises intermédiaires ou de fin : jamais inconnues de l'utilisateur, seulement mal placées. */
const INNER_TAGS = /^(?:end\w*|else|elif)$/;

/** Valeur de vérité d'un nombre littéral (chiffres Unicode non ASCII : supposés non nuls). */
function constTruthy(token: Token, v3: boolean): boolean {
  const digits = token.value.replace(/_/g, "");
  if (token.type === "float") return Number(digits) !== 0;
  if (v3 && /^0[bBoOxX]/.test(digits)) return /[1-9a-fA-F]/.test(digits.slice(2));
  return /[^0]/.test(digits);
}

const PY_BLANK = new RegExp(`^${PY_SPACE}+$`, "u");

class Parser {
  private readonly stream: TokenStream;
  private readonly tagStack: string[] = [];
  private readonly endTokenStack: string[][] = [];
  private readonly v3: boolean;

  constructor(
    source: string,
    private readonly env: JinjaEnvironment,
  ) {
    this.v3 = env.version !== "2.11.3";
    this.stream = new TokenStream(tokenize(source, env));
  }

  private fail(
    message: string,
    line = this.stream.current.line,
    code: JinjaCode = "jinja.syntax",
    params?: Record<string, string>,
  ): never {
    throw new JinjaFailure(code, line, message, params);
  }

  private failUtEof(
    name: string | undefined,
    stack: readonly string[][],
    line: number,
    openLine?: number,
  ): never {
    const expected = new Set(stack.flatMap((exprs) => exprs.map(describeExpr)));
    const last = stack.at(-1);
    const looking = last ? last.map((e) => pyRepr(describeExpr(e))).join(" or ") : undefined;
    const message = [
      name === undefined
        ? "Unexpected end of template."
        : `Encountered unknown tag ${pyRepr(name)}.`,
    ];
    const nesting = name !== undefined && expected.has(name);
    if (looking) {
      message.push(
        nesting
          ? `You probably made a nesting mistake. Jinja is expecting this tag, but currently looking for ${looking}.`
          : `Jinja was looking for the following tags: ${looking}.`,
      );
    }
    const innermost = this.tagStack.at(-1);
    if (innermost !== undefined)
      message.push(`The innermost block that needs to be closed is ${pyRepr(innermost)}.`);
    if (name === undefined) {
      throw new JinjaFailure(
        "jinja.unclosed-block",
        line,
        message.join(" "),
        { tag: innermost ?? "" },
        openLine ?? line,
      );
    }
    throw new JinjaFailure(
      nesting || INNER_TAGS.test(name) ? "jinja.unexpected-tag" : "jinja.unknown-tag",
      line,
      message.join(" "),
      { tag: name },
    );
  }

  parse(): Stmt[] {
    return this.subparse(undefined);
  }

  /**
   * Fin de tuple. Jinja passe ses règles de fin supplémentaires (`in`, `recursive`) à `test_any`
   * sans les dépaqueter : elles ne correspondent jamais, d'où `{% for a, in c %}` refusé. Reproduit.
   */
  private isTupleEnd(): boolean {
    const type = this.stream.current.type;
    return type === "variable_end" || type === "block_end" || type === "rparen";
  }

  private parseStatement(): Stmt {
    const token = this.stream.current;
    if (token.type !== "name") this.fail("tag name expected", token.line);
    this.tagStack.push(token.value);
    let popTag = true;
    try {
      switch (token.value) {
        case "for":
          return this.parseFor();
        case "if":
          return this.parseIf();
        case "block":
          return this.parseBlock();
        case "extends":
          return {
            kind: "extends",
            line: this.stream.next().line,
            template: this.parseExpression(),
          };
        case "print":
          return this.parsePrint();
        case "macro":
          return this.parseMacro();
        case "include":
          return this.parseInclude();
        case "from":
          return this.parseFrom();
        case "import":
          return this.parseImport();
        case "set":
          return this.parseSet();
        case "with":
          return this.parseWith();
        case "autoescape":
          return this.parseAutoescape();
        case "call":
          return this.parseCallBlock();
        case "filter":
          return this.parseFilterBlock();
      }
      if (this.env.extensions.includes("do") && token.value === "do") {
        return { kind: "exprstmt", line: this.stream.next().line, node: this.parseTuple() };
      }
      if (
        this.env.extensions.includes("loopcontrols") &&
        (token.value === "break" || token.value === "continue")
      ) {
        const control = this.stream.next();
        return { kind: control.value === "break" ? "break" : "continue", line: control.line };
      }
      this.tagStack.pop();
      popTag = false;
      return this.failUtEof(token.value, this.endTokenStack, token.line);
    } finally {
      if (popTag) this.tagStack.pop();
    }
  }

  private parseStatements(endTokens: string[], dropNeedle = false): Stmt[] {
    this.stream.skipIf("colon");
    this.stream.expect("block_end");
    const result = this.subparse(endTokens);
    if (this.stream.current.type === "eof") this.failEof(endTokens);
    if (dropNeedle) this.stream.next();
    return result;
  }

  /** Ligne de la balise ouvrante la plus intérieure, pour montrer le bloc non fermé. */
  private readonly openLines: number[] = [];

  private failEof(endTokens: string[]): never {
    return this.failUtEof(
      undefined,
      [...this.endTokenStack, endTokens],
      this.stream.current.line,
      this.openLines.at(-1),
    );
  }

  private withOpenLine<T>(line: number, parse: () => T): T {
    this.openLines.push(line);
    try {
      return parse();
    } finally {
      this.openLines.pop();
    }
  }

  private parseSet(): Stmt {
    const line = this.stream.next().line;
    const target = this.parseAssignTarget({ withNamespace: true });
    if (this.stream.skipIf("assign"))
      return { kind: "assign", target, node: this.parseTuple(), line };
    const filter = this.parseFilter(undefined);
    const body = this.withOpenLine(line, () => this.parseStatements(["name:endset"], true));
    return { kind: "assignblock", target, filter, body, line };
  }

  private parseFor(): Stmt {
    const line = this.stream.expect("name:for").line;
    const target = this.parseAssignTarget({});
    this.stream.expect("name:in");
    const iter = this.parseTuple({ withCondexpr: false });
    const testExpr = this.stream.skipIf("name:if") ? this.parseExpression() : undefined;
    const recursive = this.stream.skipIf("name:recursive");
    return this.withOpenLine(line, () => {
      const body = this.parseStatements(["name:endfor", "name:else"]);
      const else_ =
        this.stream.next().value === "endfor" ? [] : this.parseStatements(["name:endfor"], true);
      return { kind: "for", target, iter, body, else_, test: testExpr, recursive, line } as const;
    });
  }

  private parseIf(): Stmt {
    const line = this.stream.expect("name:if").line;
    const branches = ["name:elif", "name:else", "name:endif"];
    return this.withOpenLine(line, () => {
      const condition = this.parseTuple({ withCondexpr: false });
      const result: Extract<Stmt, { kind: "if" }> = {
        kind: "if",
        test: condition,
        body: this.parseStatements(branches),
        elifs: [],
        else_: [],
        line,
      };
      for (;;) {
        const token = this.stream.next();
        if (test(token, "name:elif")) {
          const elifTest = this.parseTuple({ withCondexpr: false });
          result.elifs.push({ test: elifTest, body: this.parseStatements(branches) });
          continue;
        }
        if (test(token, "name:else")) result.else_ = this.parseStatements(["name:endif"], true);
        return result;
      }
    });
  }

  private parseWith(): Stmt {
    const line = this.stream.next().line;
    const targets: Expr[] = [];
    const values: Expr[] = [];
    while (this.stream.current.type !== "block_end") {
      if (targets.length > 0) this.stream.expect("comma");
      const target = this.parseAssignTarget({});
      setCtx(target, "param");
      targets.push(target);
      this.stream.expect("assign");
      values.push(this.parseExpression());
    }
    const body = this.withOpenLine(line, () => this.parseStatements(["name:endwith"], true));
    return { kind: "with", targets, values, body, line };
  }

  private parseAutoescape(): Stmt {
    const line = this.stream.next().line;
    const option = this.parseExpression();
    const body = this.withOpenLine(line, () => this.parseStatements(["name:endautoescape"], true));
    return { kind: "scope", option, body, line };
  }

  private parseBlock(): Stmt {
    const line = this.stream.next().line;
    const name = this.stream.expect("name").value;
    this.stream.skipIf("name:scoped");
    const required = this.v3 && this.stream.skipIf("name:required");
    if (this.stream.current.type === "sub") {
      this.fail(
        "Block names in Jinja have to be valid Python identifiers and may not contain hyphens, use an underscore instead.",
      );
    }
    const body = this.withOpenLine(line, () => this.parseStatements(["name:endblock"], true));
    if (
      required &&
      !body.every(
        (node) => node.kind === "output" && node.nodes.length === 0 && !this.nonSpaceData.has(node),
      )
    ) {
      this.fail("Required blocks can only contain comments or whitespace");
    }
    this.stream.skipIf(`name:${name}`);
    return { kind: "block", name, body, line };
  }

  private parseInclude(): Stmt {
    const line = this.stream.next().line;
    const template = this.parseExpression();
    if (test(this.stream.current, "name:ignore") && test(this.stream.look(), "name:missing"))
      this.stream.skip(2);
    this.parseImportContext();
    return { kind: "include", template, line };
  }

  private parseImportContext(): void {
    if (
      (test(this.stream.current, "name:with") || test(this.stream.current, "name:without")) &&
      test(this.stream.look(), "name:context")
    ) {
      this.stream.next();
      this.stream.skip();
    }
  }

  private parseImport(): Stmt {
    const line = this.stream.next().line;
    const template = this.parseExpression();
    this.stream.expect("name:as");
    this.parseAssignTarget({ nameOnly: true });
    this.parseImportContext();
    return { kind: "import", template, line };
  }

  private parseFrom(): Stmt {
    const line = this.stream.next().line;
    const template = this.parseExpression();
    this.stream.expect("name:import");
    let names = 0;
    const parseContext = () => {
      if (
        (this.stream.current.value === "with" || this.stream.current.value === "without") &&
        test(this.stream.look(), "name:context")
      ) {
        this.stream.next();
        this.stream.skip();
        return true;
      }
      return false;
    };
    for (;;) {
      if (names > 0) this.stream.expect("comma");
      if (this.stream.current.type === "name") {
        if (parseContext()) break;
        const target = this.parseAssignTarget({ nameOnly: true });
        if (target.kind === "name" && target.name.startsWith("_")) {
          this.fail("names starting with an underline can not be imported", target.line);
        }
        if (this.stream.skipIf("name:as")) this.parseAssignTarget({ nameOnly: true });
        names += 1;
        // Relu après les appels : le type du jeton courant a changé (pas de rétrécissement).
        if (parseContext() || (this.stream.current as Token).type !== "comma") break;
      } else this.stream.expect("name");
    }
    return { kind: "fromimport", template, line };
  }

  private parseSignature(): { args: Expr[]; defaults: Expr[] } {
    const args: Expr[] = [];
    const defaults: Expr[] = [];
    this.stream.expect("lparen");
    while (this.stream.current.type !== "rparen") {
      if (args.length > 0) this.stream.expect("comma");
      const arg = this.parseAssignTarget({ nameOnly: true });
      setCtx(arg, "param");
      if (this.stream.skipIf("assign")) defaults.push(this.parseExpression());
      else if (defaults.length > 0) this.fail("non-default argument follows default argument");
      args.push(arg);
    }
    this.stream.expect("rparen");
    return { args, defaults };
  }

  private parseCallBlock(): Stmt {
    const line = this.stream.next().line;
    const signature =
      this.stream.current.type === "lparen" ? this.parseSignature() : { args: [], defaults: [] };
    const call = this.parseExpression();
    if (call.kind !== "call") this.fail("expected call", line);
    const body = this.withOpenLine(line, () => this.parseStatements(["name:endcall"], true));
    return { kind: "callblock", call, ...signature, body, line };
  }

  private parseFilterBlock(): Stmt {
    const line = this.stream.next().line;
    const filter = this.parseFilter(undefined, true) as Expr;
    const body = this.withOpenLine(line, () => this.parseStatements(["name:endfilter"], true));
    return { kind: "filterblock", filter, body, line };
  }

  private parseMacro(): Stmt {
    const line = this.stream.next().line;
    this.parseAssignTarget({ nameOnly: true });
    const signature = this.parseSignature();
    const body = this.withOpenLine(line, () => this.parseStatements(["name:endmacro"], true));
    return { kind: "macro", ...signature, body, line };
  }

  private parsePrint(): Stmt {
    const line = this.stream.next().line;
    const nodes: Expr[] = [];
    while (this.stream.current.type !== "block_end") {
      if (nodes.length > 0) this.stream.expect("comma");
      nodes.push(this.parseExpression());
    }
    return { kind: "output", nodes, line };
  }

  private parseAssignTarget(options: { nameOnly?: boolean; withNamespace?: boolean }): Expr {
    let target: Expr;
    if (!this.v3 && options.withNamespace && this.stream.look().type === "dot") {
      const token = this.stream.expect("name");
      this.stream.next();
      this.stream.expect("name");
      target = { kind: "nsref", name: token.value, line: token.line };
    } else if (options.nameOnly) {
      const token = this.stream.expect("name");
      target = { kind: "name", name: token.value, ctx: "store", line: token.line };
    } else {
      target = this.parseTuple({ simplified: true, withNamespace: options.withNamespace ?? false });
      setCtx(target, "store");
    }
    if (!canAssign(target)) this.fail(`can't assign to ${pyRepr(nodeClass(target))}`, target.line);
    return target;
  }

  private parseExpression(withCondexpr = true): Expr {
    return withCondexpr ? this.parseCondexpr() : this.parseOr();
  }

  private parseCondexpr(): Expr {
    let line = this.stream.current.line;
    let expr1 = this.parseOr();
    while (this.stream.skipIf("name:if")) {
      const expr2 = this.parseOr();
      const expr3 = this.stream.skipIf("name:else") ? this.parseCondexpr() : undefined;
      expr1 = { kind: "condexpr", test: expr2, expr1, expr2: expr3, line };
      line = this.stream.current.line;
    }
    return expr1;
  }

  private parseBinary(op: string | ((type: string) => boolean), next: () => Expr): Expr {
    let line = this.stream.current.line;
    let left = next();
    for (;;) {
      const current = this.stream.current;
      const name =
        typeof op === "string"
          ? test(current, `name:${op}`)
            ? op
            : undefined
          : op(current.type)
            ? current.type
            : undefined;
      if (name === undefined) return left;
      this.stream.next();
      left = { kind: "binop", op: name, left, right: next(), line };
      line = this.stream.current.line;
    }
  }

  private parseOr(): Expr {
    return this.parseBinary("or", () => this.parseAnd());
  }

  private parseAnd(): Expr {
    return this.parseBinary("and", () => this.parseNot());
  }

  private parseNot(): Expr {
    if (test(this.stream.current, "name:not")) {
      const line = this.stream.next().line;
      return { kind: "unary", op: "not", node: this.parseNot(), line };
    }
    return this.parseCompare();
  }

  private parseCompare(): Expr {
    let line = this.stream.current.line;
    const expr = this.parseMath1();
    const ops: Expr[] = [];
    for (;;) {
      const type = this.stream.current.type;
      if (COMPARE_OPERATORS.has(type)) {
        this.stream.next();
        ops.push(this.parseMath1());
      } else if (this.stream.skipIf("name:in")) ops.push(this.parseMath1());
      else if (test(this.stream.current, "name:not") && test(this.stream.look(), "name:in")) {
        this.stream.skip(2);
        ops.push(this.parseMath1());
      } else break;
      line = this.stream.current.line;
    }
    return ops.length === 0 ? expr : { kind: "compare", expr, ops, line };
  }

  private parseMath1(): Expr {
    return this.parseBinary(
      (t) => t === "add" || t === "sub",
      () => this.parseConcat(),
    );
  }

  private parseConcat(): Expr {
    const line = this.stream.current.line;
    const nodes = [this.parseMath2()];
    while (this.stream.current.type === "tilde") {
      this.stream.next();
      nodes.push(this.parseMath2());
    }
    return nodes.length === 1 ? (nodes[0] as Expr) : { kind: "concat", nodes, line };
  }

  private parseMath2(): Expr {
    return this.parseBinary(
      (t) => t === "mul" || t === "div" || t === "floordiv" || t === "mod",
      () => this.parsePow(),
    );
  }

  private parsePow(): Expr {
    return this.parseBinary(
      (t) => t === "pow",
      () => this.parseUnary(),
    );
  }

  private parseUnary(withFilter = true): Expr {
    const type = this.stream.current.type;
    const line = this.stream.current.line;
    let node: Expr;
    if (type === "sub" || type === "add") {
      this.stream.next();
      node = {
        kind: "unary",
        op: type === "sub" ? "neg" : "pos",
        node: this.parseUnary(false),
        line,
      };
    } else node = this.parsePrimary();
    node = this.parsePostfix(node);
    return withFilter ? this.parseFilterExpr(node) : node;
  }

  /** Blocs `required` : sorties qui contiennent du texte autre que des blancs. */
  private readonly nonSpaceData = new WeakSet<Stmt>();

  private parsePrimary(withNamespace = false): Expr {
    const token = this.stream.current;
    if (token.type === "name") {
      this.stream.next();
      if (["true", "false", "True", "False"].includes(token.value))
        return {
          kind: "const",
          truthy: token.value === "true" || token.value === "True",
          line: token.line,
        };
      if (token.value === "none" || token.value === "None")
        return { kind: "const", truthy: false, line: token.line };
      if (this.v3 && withNamespace && this.stream.current.type === "dot") {
        this.stream.next();
        this.stream.expect("name");
        return { kind: "nsref", name: token.value, line: token.line };
      }
      return { kind: "name", name: token.value, ctx: "load", line: token.line };
    }
    if (token.type === "string") {
      this.stream.next();
      let empty = decodeString(token.value.slice(1, -1)).empty;
      while (this.stream.current.type === "string") {
        empty &&= decodeString(this.stream.current.value.slice(1, -1)).empty;
        this.stream.next();
      }
      return { kind: "const", truthy: !empty, line: token.line };
    }
    if (token.type === "integer" || token.type === "float") {
      this.stream.next();
      return { kind: "const", truthy: constTruthy(token, this.v3), line: token.line };
    }
    if (token.type === "lparen") {
      this.stream.next();
      const node = this.parseTuple({ explicit: true });
      this.stream.expect("rparen");
      return node;
    }
    if (token.type === "lbracket") {
      const start = this.stream.expect("lbracket");
      const items: Expr[] = [];
      while (this.stream.current.type !== "rbracket") {
        if (items.length > 0) this.stream.expect("comma");
        if (this.stream.current.type === "rbracket") break;
        items.push(this.parseExpression());
      }
      this.stream.expect("rbracket");
      return { kind: "list", items, line: start.line };
    }
    if (token.type === "lbrace") {
      const start = this.stream.expect("lbrace");
      const items: { key: Expr; value: Expr }[] = [];
      while (this.stream.current.type !== "rbrace") {
        if (items.length > 0) this.stream.expect("comma");
        if (this.stream.current.type === "rbrace") break;
        const key = this.parseExpression();
        this.stream.expect("colon");
        items.push({ key, value: this.parseExpression() });
      }
      this.stream.expect("rbrace");
      return { kind: "dict", items, line: start.line };
    }
    return this.fail(
      `unexpected ${pyRepr(describe(token))}`,
      token.line,
      token.type === "eof" ? "jinja.unexpected-end" : "jinja.syntax",
    );
  }

  private parseTuple(
    options: {
      simplified?: boolean;
      withCondexpr?: boolean;
      explicit?: boolean;
      withNamespace?: boolean;
    } = {},
  ): Expr {
    let line = this.stream.current.line;
    const parse = options.simplified
      ? () => this.parsePrimary(options.withNamespace)
      : () => this.parseExpression(options.withCondexpr ?? true);
    const args: Expr[] = [];
    let isTuple = false;
    for (;;) {
      if (args.length > 0) this.stream.expect("comma");
      if (this.isTupleEnd()) break;
      args.push(parse());
      if (this.stream.current.type === "comma") isTuple = true;
      else break;
      line = this.stream.current.line;
    }
    if (!isTuple) {
      if (args[0]) return args[0];
      if (!options.explicit) {
        const current = this.stream.current;
        this.fail(
          `Expected an expression, got ${pyRepr(describe(current))}`,
          current.line,
          current.type === "eof" ? "jinja.unexpected-end" : "jinja.syntax",
        );
      }
    }
    return { kind: "tuple", items: args, ctx: "load", line };
  }

  private parsePostfix(start: Expr): Expr {
    let node = start;
    for (;;) {
      const type = this.stream.current.type;
      if (type === "dot" || type === "lbracket") node = this.parseSubscript(node);
      else if (type === "lparen") node = this.parseCall(node);
      else return node;
    }
  }

  private parseFilterExpr(start: Expr): Expr {
    let node = start;
    for (;;) {
      const type = this.stream.current.type;
      if (type === "pipe") node = this.parseFilter(node) as Expr;
      else if (type === "name" && this.stream.current.value === "is") node = this.parseTest(node);
      else if (type === "lparen") node = this.parseCall(node);
      else return node;
    }
  }

  private parseSubscript(node: Expr): Expr {
    const token = this.stream.next();
    if (token.type === "dot") {
      const attribute = this.stream.current;
      this.stream.next();
      if (attribute.type === "name") return { kind: "getattr", node, line: token.line };
      if (attribute.type !== "integer") this.fail("expected name or number", attribute.line);
      return {
        kind: "getitem",
        node,
        arg: { kind: "const", truthy: true, line: attribute.line },
        line: token.line,
      };
    }
    const args: Expr[] = [];
    while (this.stream.current.type !== "rbracket") {
      if (args.length > 0) this.stream.expect("comma");
      args.push(this.parseSubscribed());
    }
    this.stream.expect("rbracket");
    const arg: Expr =
      args.length === 1
        ? (args[0] as Expr)
        : { kind: "tuple", items: args, ctx: "load", line: token.line };
    return { kind: "getitem", node, arg, line: token.line };
  }

  private parseSubscribed(): Expr {
    const line = this.stream.current.line;
    const parts: (Expr | undefined)[] = [];
    if (this.stream.current.type === "colon") {
      this.stream.next();
      parts.push(undefined);
    } else {
      const node = this.parseExpression();
      if (this.stream.current.type !== "colon") return node;
      this.stream.next();
      parts.push(node);
    }
    const type = () => this.stream.current.type;
    if (type() !== "colon" && type() !== "rbracket" && type() !== "comma")
      parts.push(this.parseExpression());
    if (type() === "colon") {
      this.stream.next();
      if (type() !== "rbracket" && type() !== "comma") parts.push(this.parseExpression());
    }
    return { kind: "slice", parts, line };
  }

  private parseCallArgs(): CallArgs {
    const token = this.stream.expect("lparen");
    const result: CallArgs = { args: [], kwargs: [], dynArgs: undefined, dynKwargs: undefined };
    const mutable = result as { dynArgs: Expr | undefined; dynKwargs: Expr | undefined };
    const ensure = (condition: boolean) => {
      if (!condition) this.fail("invalid syntax for function call expression", token.line);
    };
    let requireComma = false;
    while (this.stream.current.type !== "rparen") {
      if (requireComma) {
        this.stream.expect("comma");
        if (this.stream.current.type === "rparen") break;
      }
      if (this.stream.current.type === "mul") {
        ensure(result.dynArgs === undefined && result.dynKwargs === undefined);
        this.stream.next();
        mutable.dynArgs = this.parseExpression();
      } else if (this.stream.current.type === "pow") {
        ensure(result.dynKwargs === undefined);
        this.stream.next();
        mutable.dynKwargs = this.parseExpression();
      } else if (this.stream.current.type === "name" && this.stream.look().type === "assign") {
        ensure(result.dynKwargs === undefined);
        const key = this.stream.current.value;
        this.stream.skip(2);
        result.kwargs.push({ key, value: this.parseExpression() });
      } else {
        ensure(
          result.dynArgs === undefined &&
            result.dynKwargs === undefined &&
            result.kwargs.length === 0,
        );
        result.args.push(this.parseExpression());
      }
      requireComma = true;
    }
    this.stream.expect("rparen");
    return result;
  }

  private parseCall(node: Expr): Expr {
    const line = this.stream.current.line;
    return { kind: "call", node, args: this.parseCallArgs(), line };
  }

  private parseFilter(start: Expr | undefined, startInline = false): Expr | undefined {
    let node = start;
    let inline = startInline;
    while (this.stream.current.type === "pipe" || inline) {
      if (!inline) this.stream.next();
      const token = this.stream.expect("name");
      let name = token.value;
      while (this.stream.current.type === "dot") {
        this.stream.next();
        name += `.${this.stream.expect("name").value}`;
      }
      const args =
        this.stream.current.type === "lparen"
          ? this.parseCallArgs()
          : { args: [], kwargs: [], dynArgs: undefined, dynKwargs: undefined };
      node = { kind: "filter", node, name, args, line: token.line };
      inline = false;
    }
    return node;
  }

  private parseTest(node: Expr): Expr {
    const token = this.stream.next();
    const negated = this.stream.skipIf("name:not");
    let name = this.stream.expect("name").value;
    while (this.stream.current.type === "dot") {
      this.stream.next();
      name += `.${this.stream.expect("name").value}`;
    }
    let args: CallArgs = { args: [], kwargs: [], dynArgs: undefined, dynKwargs: undefined };
    const current = this.stream.current;
    if (current.type === "lparen") args = this.parseCallArgs();
    else if (
      ["name", "string", "integer", "float", "lparen", "lbracket", "lbrace"].includes(
        current.type,
      ) &&
      !["name:else", "name:or", "name:and"].some((e) => test(current, e))
    ) {
      if (test(current, "name:is")) this.fail("You cannot chain multiple tests with is");
      args = { ...args, args: [this.parsePostfix(this.parsePrimary())] };
    }
    const result: Expr = { kind: "test", node, name, args, line: token.line };
    return negated ? { kind: "unary", op: "not", node: result, line: token.line } : result;
  }

  private subparse(endTokens: string[] | undefined): Stmt[] {
    const body: Stmt[] = [];
    if (endTokens) this.endTokenStack.push(endTokens);
    try {
      while (this.stream.more) {
        const token = this.stream.current;
        if (token.type === "data") {
          if (!PY_BLANK.test(token.value)) {
            const output: Stmt = { kind: "output", nodes: [], line: token.line };
            this.nonSpaceData.add(output);
            body.push(output);
          }
          this.stream.next();
        } else if (token.type === "variable_begin") {
          const begin = this.stream.next();
          // « {{ x }} » : syntaxe de Jinja standard, pas celle de Klipper (délimiteurs « { } »).
          const next = this.stream.current;
          const double = next.type === "lbrace" && next.start === begin.start + begin.value.length;
          try {
            body.push({
              kind: "output",
              nodes: [this.parseTuple({ withCondexpr: true })],
              line: begin.line,
            });
            this.stream.expect("variable_end");
          } catch (error) {
            if (
              double &&
              error instanceof JinjaFailure &&
              ["jinja.syntax", "jinja.unexpected-end", "jinja.unbalanced"].includes(error.code)
            ) {
              throw new JinjaFailure(
                "jinja.double-brace",
                error.jinjaLine,
                error.message,
                {},
                begin.line,
              );
            }
            throw error;
          }
        } else if (token.type === "block_begin") {
          this.stream.next();
          if (endTokens?.some((e) => test(this.stream.current, e))) return body;
          body.push(this.parseStatement());
          this.stream.expect("block_end");
        } else throw new Error("internal parsing error");
      }
      return body;
    } finally {
      if (endTokens) this.endTokenStack.pop();
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Contrôles de compilation (jinja2/compiler.py, CodeGenerator)

/** Mots-clés de Python (`keyword.iskeyword`) : arguments nommés passés autrement par Jinja. */
const PY_KEYWORDS = new Set([
  "False",
  "None",
  "True",
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield",
]);

interface Frame {
  readonly toplevel: boolean;
  readonly rootlevel: boolean;
  readonly requireOutputCheck: boolean;
  /** Corps d'un `if` ou d'une expression conditionnelle (Jinja 3 : filtre inconnu toléré). */
  readonly soft: boolean;
  /** Dans une boucle `for` du code Python généré (sans fonction entre les deux). */
  readonly inLoop: boolean;
}

const inner = (frame: Frame, overrides: Partial<Frame> = {}): Frame => ({
  toplevel: false,
  rootlevel: false,
  requireOutputCheck: frame.requireOutputCheck,
  soft: false,
  inLoop: frame.inLoop,
  ...overrides,
});

/**
 * Valeur de vérité d'une expression constante (`as_const` de Jinja), undefined si elle ne l'est
 * pas. Les sous-arbres constants sont remplacés avant la génération : leurs filtres ne sont jamais
 * contrôlés (`false and x|inconnu` passe).
 */
function asConst(node: Expr): boolean | undefined {
  switch (node.kind) {
    case "const":
      return node.truthy;
    case "tuple":
    case "list":
      return node.items.every((i) => asConst(i) !== undefined) ? node.items.length > 0 : undefined;
    case "dict":
      return node.items.every(
        (p) =>
          asConst(p.key) !== undefined &&
          asConst(p.value) !== undefined &&
          p.key.kind !== "list" &&
          p.key.kind !== "dict",
      )
        ? node.items.length > 0
        : undefined;
    case "unary": {
      if (node.op !== "not") return undefined;
      const value = asConst(node.node);
      return value === undefined ? undefined : !value;
    }
    case "binop": {
      if (node.op !== "and" && node.op !== "or") return undefined;
      const left = asConst(node.left);
      if (left === undefined) return undefined;
      return node.op === "and"
        ? left
          ? asConst(node.right)
          : false
        : left
          ? true
          : asConst(node.right);
    }
    case "condexpr": {
      const value = asConst(node.test);
      if (value === undefined) return undefined;
      if (value) return asConst(node.expr1);
      return node.expr2 ? asConst(node.expr2) : undefined;
    }
    default:
      return undefined;
  }
}

/** Nœuds dont le visiteur de Jinja tente le repliement (`@optimizeconst`). */
const OPTIMIZED = new Set([
  "binop",
  "unary",
  "compare",
  "concat",
  "getattr",
  "getitem",
  "call",
  "filter",
  "test",
  "condexpr",
]);

class Checker {
  private knownExtends = false;
  private extendsSoFar = 0;
  private volatile = false;
  private readonly v3: boolean;
  readonly runtime: JinjaIssue[] = [];
  readonly loopControls: Stmt[] = [];

  constructor(private readonly env: JinjaEnvironment) {
    this.v3 = env.version !== "2.11.3";
  }

  run(body: Stmt[]): void {
    const blocks = new Map<string, Extract<Stmt, { kind: "block" }>>();
    for (const node of findAll(body)) {
      if (node.kind !== "block") continue;
      if (blocks.has(node.name))
        throw new JinjaFailure(
          "jinja.syntax",
          node.line,
          `block ${pyRepr(node.name)} defined twice`,
        );
      blocks.set(node.name, node);
    }
    const haveExtends = [...findAll(body)].some((n) => n.kind === "extends");
    this.blockvisit(body, {
      toplevel: true,
      rootlevel: true,
      requireOutputCheck: haveExtends,
      soft: false,
      inLoop: false,
    });
    for (const block of blocks.values()) {
      this.blockvisit(block.body, {
        toplevel: false,
        rootlevel: false,
        requireOutputCheck: false,
        soft: false,
        inLoop: false,
      });
    }
  }

  private blockvisit(nodes: readonly Stmt[], frame: Frame): void {
    try {
      for (const node of nodes) this.visitStmt(node, frame);
    } catch (error) {
      if (!(error instanceof CompilerExit)) throw error;
    }
  }

  private visitStmt(node: Stmt, frame: Frame): void {
    switch (node.kind) {
      case "output":
        if (frame.requireOutputCheck && this.knownExtends) return;
        for (const child of node.nodes) if (asConst(child) === undefined) this.visit(child, frame);
        return;
      case "extends":
        if (!frame.toplevel)
          throw new JinjaFailure(
            "jinja.syntax",
            node.line,
            "cannot use extend from a non top-level scope",
          );
        if (this.extendsSoFar > 0 && this.knownExtends) throw new CompilerExit();
        this.visit(node.template, frame);
        if (frame.rootlevel) this.knownExtends = true;
        this.extendsSoFar += 1;
        return;
      case "include":
      case "import":
      case "fromimport":
        this.visit(node.template, frame);
        return;
      case "for": {
        if (node.test) this.visit(node.test, inner(frame));
        for (const name of findAll([node])) {
          if (name.kind === "name" && name.ctx === "store" && name.name === "loop") {
            throw new JinjaFailure(
              "jinja.syntax",
              name.line,
              "Can't assign to special loop variable in for-loop target",
            );
          }
        }
        if (!node.recursive) this.visit(node.iter, frame);
        this.blockvisit(node.body, inner(frame, { inLoop: true }));
        if (node.else_.length > 0)
          this.blockvisit(node.else_, inner(frame, node.recursive ? { inLoop: false } : {}));
        if (node.recursive) this.visit(node.iter, frame);
        return;
      }
      case "if": {
        const soft: Frame = { ...frame, rootlevel: false, soft: true };
        this.visit(node.test, soft);
        this.blockvisit(node.body, soft);
        for (const elif of node.elifs) {
          this.visit(elif.test, soft);
          this.blockvisit(elif.body, soft);
        }
        this.blockvisit(node.else_, soft);
        return;
      }
      case "macro":
        this.macroBody(node, frame);
        return;
      case "callblock":
        this.macroBody(node, frame);
        this.visit(node.call, frame);
        return;
      case "filterblock": {
        const filterFrame = inner(frame);
        this.blockvisit(node.body, filterFrame);
        this.visit(node.filter, filterFrame);
        return;
      }
      case "with": {
        const withFrame = inner(frame);
        for (const value of node.values) this.visit(value, frame);
        this.blockvisit(node.body, withFrame);
        return;
      }
      case "exprstmt":
        this.visit(node.node, frame);
        return;
      case "assign":
        this.visit(node.node, frame);
        return;
      case "assignblock": {
        const blockFrame = inner(frame, { requireOutputCheck: false });
        this.blockvisit(node.body, blockFrame);
        if (node.filter) this.visit(node.filter, blockFrame);
        return;
      }
      case "scope": {
        // `Scope([ScopedEvalContextModifier])` : un `CompilerExit` du corps saute le retour au contexte.
        const scopeFrame = inner(frame);
        try {
          const saved = this.volatile;
          this.visit(node.option, scopeFrame);
          if (asConst(node.option) === undefined) this.volatile = true;
          for (const child of node.body) this.visitStmt(child, scopeFrame);
          this.volatile = saved;
        } catch (error) {
          if (!(error instanceof CompilerExit)) throw error;
        }
        return;
      }
      case "break":
      case "continue":
        if (!frame.inLoop) this.loopControls.push(node);
        return;
      case "block":
        return;
    }
  }

  private macroBody(node: Extract<Stmt, { kind: "macro" | "callblock" }>, frame: Frame): void {
    const macroFrame = inner(frame, { requireOutputCheck: false, inLoop: false });
    const callerIndex = node.args.findIndex((a) => a.kind === "name" && a.name === "caller");
    if (
      callerIndex >= 0 &&
      this.loadsCaller(node.body) &&
      callerIndex - node.args.length < -node.defaults.length
    ) {
      throw new JinjaFailure(
        "jinja.syntax",
        node.line,
        'When defining macros or call blocks the special "caller" argument must be omitted or be given a default.',
      );
    }
    node.args.forEach((_arg, index) => {
      const offset = index - node.args.length;
      const value =
        offset >= -node.defaults.length ? node.defaults[node.defaults.length + offset] : undefined;
      if (value) this.visit(value, macroFrame);
    });
    this.blockvisit(node.body, macroFrame);
  }

  /** `find_undeclared(body, ("caller",))` : la première occurrence du nom décide. */
  private loadsCaller(body: readonly Stmt[]): boolean {
    for (const node of findAll(body, true)) {
      if (node.kind === "name" && node.name === "caller") return node.ctx === "load";
    }
    return false;
  }

  private visit(node: Expr, frame: Frame): void {
    if (OPTIMIZED.has(node.kind) && !this.volatile && asConst(node) !== undefined) return;
    switch (node.kind) {
      case "tuple":
      case "list":
        for (const item of node.items) this.visit(item, frame);
        return;
      case "dict":
        for (const pair of node.items) {
          this.visit(pair.key, frame);
          this.visit(pair.value, frame);
        }
        return;
      case "binop":
        this.visit(node.left, frame);
        this.visit(node.right, frame);
        return;
      case "unary":
      case "getattr":
        this.visit(node.node, frame);
        return;
      case "compare":
        this.visit(node.expr, frame);
        for (const op of node.ops) this.visit(op, frame);
        return;
      case "concat":
        for (const item of node.nodes) this.visit(item, frame);
        return;
      case "getitem":
        this.visit(node.node, frame);
        this.visit(node.arg, frame);
        return;
      case "slice":
        for (const part of node.parts) if (part) this.visit(part, frame);
        return;
      case "call":
        this.visit(node.node, frame);
        this.signature(node.args, frame);
        return;
      case "filter":
      case "test":
        this.checkName(node, frame);
        if (node.node) this.visit(node.node, frame);
        this.signature(node.args, frame);
        return;
      case "condexpr": {
        const soft = this.v3 ? { ...frame, rootlevel: false, soft: true } : frame;
        this.visit(node.expr1, soft);
        this.visit(node.test, soft);
        if (node.expr2) this.visit(node.expr2, soft);
        return;
      }
      default:
        return;
    }
  }

  private checkName(node: Extract<Expr, { kind: "filter" | "test" }>, frame: Frame): void {
    const filter = node.kind === "filter";
    if ((filter ? this.env.filters : this.env.tests).has(node.name)) return;
    const code = filter ? "jinja.unknown-filter" : "jinja.unknown-test";
    const type = filter ? "filter" : "test";
    const message = this.v3
      ? `No ${type} named ${pyRepr(node.name)}.`
      : `no ${type} named ${pyRepr(node.name)}`;
    if (this.v3 && frame.soft) {
      // Jinja 3 : dans un `if`, l'erreur n'est levée que si la branche s'exécute.
      this.runtime.push({
        code,
        line: node.line,
        message: `No ${type} named ${pyRepr(node.name)} found.`,
        startup: false,
        params: { name: node.name },
      });
      return;
    }
    throw new JinjaFailure(code, node.line, message, { name: node.name });
  }

  private signature(args: CallArgs, frame: Frame): void {
    const workaround = args.kwargs.some((k) => PY_KEYWORDS.has(k.key));
    for (const arg of args.args) this.visit(arg, frame);
    if (!workaround) for (const kwarg of args.kwargs) this.visit(kwarg.value, frame);
    if (args.dynArgs) this.visit(args.dynArgs, frame);
    if (workaround) for (const kwarg of args.kwargs) this.visit(kwarg.value, frame);
    if (args.dynKwargs) this.visit(args.dynKwargs, frame);
  }
}

// ---------------------------------------------------------------------------------------------

/**
 * Vérifie un modèle comme Jinja le compile au démarrage de Klipper. Renvoie au plus une erreur de
 * démarrage (la première, comme Jinja), précédée des erreurs qui n'apparaîtront qu'à l'exécution.
 */
export function lintTemplate(
  source: string,
  env: JinjaEnvironment = JINJA_ENVIRONMENTS.klipper,
): JinjaIssue[] {
  let checker: Checker | undefined;
  try {
    const body = new Parser(source, env).parse();
    checker = new Checker(env);
    checker.run(body);
    // Code Python généré, compilé ensuite : `break` ou `continue` hors d'une boucle.
    const control = checker.loopControls[0];
    if (control) {
      return [
        ...checker.runtime,
        {
          code: "jinja.loop-control",
          line: control.line,
          message:
            control.kind === "break" ? "'break' outside loop" : "'continue' not properly in loop",
          startup: true,
          params: { tag: control.kind },
        },
      ];
    }
    return checker.runtime;
  } catch (error) {
    if (!(error instanceof JinjaFailure)) throw error;
    const params = Object.keys(error.params).length > 0 ? { params: error.params } : {};
    return [
      ...(checker?.runtime ?? []),
      {
        code: error.code,
        line: error.line,
        jinjaLine: error.jinjaLine,
        message: error.message,
        startup: true,
        ...params,
      },
    ];
  }
}
