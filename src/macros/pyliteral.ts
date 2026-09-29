// SPDX-License-Identifier: GPL-3.0-only
// Valeur d'une variable de macro (`variable_…`) : Klipper exige `ast.literal_eval(valeur)` puis
// `json.dumps(résultat)` sans erreur, sinon il refuse de démarrer (klippy/extras/gcode_macro.py).
// Reconnaît exactement les littéraux Python qui passent les deux : chaînes, nombres, True, False,
// None, listes, tuples, dictionnaires aux clés simples. Vérifié contre Python (oracle du corpus).

export type LiteralProblem =
  /** Mot sans guillemets (`auto`) : Python y voit un nom, pas un texte. */
  | "unquoted"
  /** `true`, `false`, `none` : Python n'accepte que True, False, None. */
  | "lowercase"
  /** Littéral valide pour Python mais pas pour JSON (ensemble, octets, nombre complexe…). */
  | "notjson"
  /** Tout le reste : expression, syntaxe invalide. */
  | "invalid";

/** Valeur analysée : nature utile pour JSON (clés de dictionnaire). */
type Value = "string" | "number" | "bool" | "none" | "tuple" | "list" | "dict" | "unhashable";

class NotLiteral extends Error {
  constructor(readonly problem: LiteralProblem) {
    super(problem);
  }
}

const invalid = (): never => {
  throw new NotLiteral("invalid");
};
const notJson = (): never => {
  throw new NotLiteral("notjson");
};

// Nombres de Python (tokenize) : entiers, flottants, imaginaires (invalides pour JSON).
const DIGITS = "[0-9](?:_?[0-9])*";
const EXPONENT = `[eE][+-]?${DIGITS}`;
const FLOAT = `(?:${DIGITS}\\.(?:${DIGITS})?(?:${EXPONENT})?|\\.${DIGITS}(?:${EXPONENT})?|${DIGITS}${EXPONENT})`;
const INTEGER =
  "(?:0[xX](?:_?[0-9a-fA-F])+|0[oO](?:_?[0-7])+|0[bB](?:_?[01])+|[1-9](?:_?[0-9])*|0+(?:_?0)*)";
const NUMBER = new RegExp(`(?:(${FLOAT}|${DIGITS})[jJ]|${FLOAT}|${INTEGER})`, "y");
const IDENTIFIER = /[\p{L}\p{Nl}_][\p{L}\p{N}\p{Mn}\p{Mc}\p{Pc}_]*/uy;
const PREFIX = /(?:[rRuUbBfF]|[bB][rR]|[rR][bB]|[fF][rR]|[rR][fF])?(?='|")/y;

class Reader {
  private pos = 0;
  /** Profondeur de parenthèses : un saut de ligne n'y est qu'un blanc. */
  private depth = 0;

  constructor(private readonly text: string) {}

  /** Saute les blancs ; hors parenthèses, un saut de ligne termine l'expression (sauf `\` final). */
  private space(): void {
    for (;;) {
      const char = this.text[this.pos];
      if (char === " " || char === "\t" || char === "\f") this.pos += 1;
      else if (char === "#") {
        // Commentaire jusqu'à la fin de ligne (Klipper les retire avant ; Python aussi les ignore).
        const end = this.text.indexOf("\n", this.pos);
        this.pos = end < 0 ? this.text.length : end;
      } else if (char === "\\" && this.text[this.pos + 1] === "\n") {
        // Ligne continuée : il faut une suite, sinon fin de fichier inattendue.
        this.pos += 2;
        if (this.text.slice(this.pos).trim() === "") invalid();
      } else if (char === "\n" && this.depth > 0) this.pos += 1;
      else return;
    }
  }

  private peek(): string | undefined {
    this.space();
    return this.text[this.pos];
  }

  private eat(char: string): boolean {
    if (this.peek() !== char) return false;
    this.pos += 1;
    return true;
  }

  parse(): void {
    // `ast.literal_eval` retire espaces et tabulations en tête ; le mode eval tolère les lignes
    // vides autour de l'expression, mais pas une première ligne utile indentée.
    const firstLine = this.text.split("\n").find((line) => line.replace(/#.*/, "").trim() !== "");
    if (
      firstLine !== undefined &&
      firstLine !== this.text.split("\n")[0] &&
      /^[ \t\f]/.test(firstLine)
    ) {
      invalid();
    }
    this.skipBlankLines();
    this.tupleOrValue(true);
    this.skipBlankLines();
    if (this.pos < this.text.length) invalid();
  }

  private skipBlankLines(): void {
    for (;;) {
      this.space();
      if (this.text[this.pos] === "\n") this.pos += 1;
      else return;
    }
  }

  /** Suite d'expressions séparées par des virgules : tuple si virgule, sinon la valeur seule. */
  private tupleOrValue(top: boolean): Value {
    const first = this.value();
    if (this.peek() !== ",") return first;
    const items: Value[] = [first];
    while (this.eat(",")) {
      const next = this.peek();
      if (next === undefined || next === ")" || (top && next === "\n")) break;
      items.push(this.value());
    }
    return items.includes("unhashable") ? "unhashable" : "tuple";
  }

  private value(): Value {
    const char = this.peek();
    if (char === undefined) return invalid();
    if (char === "-" || char === "+") {
      // Un seul signe, directement sur un nombre (`_convert_signed_num`) : `-(1)` passe, `--1` non.
      this.pos += 1;
      if (this.peek() === "(") {
        this.pos += 1;
        this.depth += 1;
        this.number();
        this.depth -= 1;
        if (!this.eat(")")) invalid();
        return "number";
      }
      this.number();
      return "number";
    }
    if (char === "(") {
      this.pos += 1;
      this.depth += 1;
      const result = this.peek() === ")" ? "tuple" : this.tupleOrValue(false);
      this.depth -= 1;
      if (!this.eat(")")) invalid();
      return result;
    }
    if (char === "[") return this.list();
    if (char === "{") return this.dict();
    if (/[0-9.]/.test(char)) {
      if (this.text.startsWith("...", this.pos)) return notJson();
      this.number();
      return "number";
    }
    PREFIX.lastIndex = this.pos;
    if (PREFIX.test(this.text)) return this.strings();
    IDENTIFIER.lastIndex = this.pos;
    const name = IDENTIFIER.exec(this.text)?.[0];
    if (name === "True" || name === "False" || name === "None") {
      this.pos += name.length;
      return name === "None" ? "none" : "bool";
    }
    return invalid();
  }

  /** Nombre constant (entier ou flottant) ; imaginaire → invalide pour JSON ; lettre collée → erreur. */
  private number(): void {
    this.space();
    NUMBER.lastIndex = this.pos;
    const found = NUMBER.exec(this.text);
    if (!found) invalid();
    const end = NUMBER.lastIndex;
    if (/[\p{L}\p{N}_]/u.test(this.text[end] ?? "")) invalid();
    this.pos = end;
    if (found?.[1] !== undefined) notJson();
  }

  private list(): Value {
    this.pos += 1;
    this.depth += 1;
    let unhashable = false;
    while (this.peek() !== "]") {
      unhashable = this.value() === "unhashable" || unhashable;
      if (!this.eat(",")) break;
    }
    this.depth -= 1;
    if (!this.eat("]")) invalid();
    return "unhashable";
  }

  /** Dictionnaire (clés acceptées par JSON : texte, nombre, booléen, None) ; ensemble → non JSON. */
  private dict(): Value {
    this.pos += 1;
    this.depth += 1;
    let entries = 0;
    let set = false;
    while (this.peek() !== "}") {
      const key = this.value();
      if (entries === 0 && this.peek() !== ":") set = true;
      if (set) {
        if (key === "unhashable") invalid();
      } else {
        if (!this.eat(":")) invalid();
        // Liste ou dictionnaire : non hachable (TypeError) ; tuple : refusé par JSON (TypeError).
        if (key === "unhashable" || key === "tuple") invalid();
        this.value();
      }
      entries += 1;
      if (!this.eat(",")) break;
    }
    this.depth -= 1;
    if (!this.eat("}")) invalid();
    if (set) notJson();
    return "unhashable";
  }

  /** Chaînes accolées ; octets ou f-chaînes → refusées (JSON, ou pas un littéral). */
  private strings(): Value {
    let kinds = "";
    for (;;) {
      PREFIX.lastIndex = this.pos;
      const prefix = PREFIX.exec(this.text)?.[0];
      if (prefix === undefined) break;
      this.pos += prefix.length;
      const lower = prefix.toLowerCase();
      kinds += lower.includes("b") ? "b" : lower.includes("f") ? "f" : "s";
      this.string(lower.includes("r"));
      const next = this.peek();
      if (next !== "'" && next !== '"' && !/[rRuUbBfF]/.test(next ?? "")) break;
      PREFIX.lastIndex = this.pos;
      if (!PREFIX.test(this.text)) break;
    }
    // Octets et texte mélangés : erreur de syntaxe ; f-chaîne : pas un littéral.
    if (kinds.includes("b") && /[sf]/.test(kinds)) invalid();
    if (kinds.includes("f")) invalid();
    if (kinds.includes("b")) notJson();
    return "string";
  }

  private string(raw: boolean): void {
    const quote = this.text[this.pos] ?? "";
    const triple = this.text.startsWith(quote.repeat(3), this.pos);
    const close = triple ? quote.repeat(3) : quote;
    this.pos += close.length;
    const start = this.pos;
    for (;;) {
      const char = this.text[this.pos];
      if (char === undefined) invalid();
      if (char === "\\") {
        this.pos += 2;
        continue;
      }
      if (char === "\n" && !triple) invalid();
      if (this.text.startsWith(close, this.pos)) break;
      this.pos += 1;
    }
    const body = this.text.slice(start, this.pos);
    this.pos += close.length;
    if (!raw) checkEscapes(body);
  }
}

/** Échappements de Python dans une chaîne non brute : ceux qui sont mal formés sont des erreurs. */
function checkEscapes(body: string): void {
  for (let i = body.indexOf("\\"); i >= 0; i = body.indexOf("\\", i + 2)) {
    const kind = body[i + 1];
    const size = kind === "x" ? 2 : kind === "u" ? 4 : kind === "U" ? 8 : 0;
    if (size > 0) {
      const hex = body.slice(i + 2, i + 2 + size);
      if (!new RegExp(`^[0-9a-fA-F]{${size}}$`).test(hex)) invalid();
      if (kind === "U" && Number.parseInt(hex, 16) > 0x10ffff) invalid();
    } else if (kind === "N") {
      const end = body.indexOf("}", i);
      if (body[i + 2] !== "{" || end < i + 4) invalid();
    }
  }
}

/** Vérifie une valeur `variable_…` comme Klipper ; undefined si elle est acceptée. */
export function checkMacroLiteral(value: string): LiteralProblem | undefined {
  try {
    new Reader(value.replace(/^[ \t]+/, "")).parse();
    return undefined;
  } catch (error) {
    if (!(error instanceof NotLiteral)) throw error;
    if (error.problem !== "invalid") return error.problem;
    const word = value.trim();
    if (/^(?:true|false|none|null)$/i.test(word)) return "lowercase";
    if (/^[\p{L}_][\p{L}\p{N}_\-./ ]*$/u.test(word)) return "unquoted";
    return "invalid";
  }
}
