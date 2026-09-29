// SPDX-License-Identifier: GPL-3.0-only

/**
 * Conversion des valeurs comme Klipper (configparser + ConfigWrapper._get_wrapper/getlists,
 * klippy/configfile.py) : `int()` et `float()` de Python, booléens de configparser, listes
 * découpées puis nettoyées, nombre d'éléments contrôlé.
 */

const PY_SPACE =
  "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const STRIP = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, "g");
export const pyStrip = (text: string) => text.replace(STRIP, "");

const DIGITS = "\\d(?:_?\\d)*";
const PY_INT = new RegExp(`^[+-]?${DIGITS}$`);
const PY_FLOAT = new RegExp(
  `^[+-]?(?:(?:${DIGITS})?\\.${DIGITS}|${DIGITS}\\.?)(?:[eE][+-]?${DIGITS})?$|^[+-]?(?:inf|infinity|nan)$`,
  "i",
);

/** `int(texte)` de Python ; undefined si Python lèverait ValueError. */
export function pyInt(text: string): number | undefined {
  const value = pyStrip(text);
  return PY_INT.test(value) ? Number(value.replaceAll("_", "")) : undefined;
}

/** `float(texte)` de Python ; undefined si Python lèverait ValueError. */
export function pyFloat(text: string): number | undefined {
  const value = pyStrip(text);
  if (!PY_FLOAT.test(value)) return undefined;
  const lower = value.toLowerCase().replace(/^\+/, "");
  if (lower.endsWith("nan")) return Number.NaN;
  if (lower.endsWith("inf") || lower.endsWith("infinity")) {
    return lower.startsWith("-") ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  }
  return Number(value.replaceAll("_", ""));
}

const BOOLEANS: Readonly<Record<string, boolean>> = {
  "1": true,
  yes: true,
  true: true,
  on: true,
  "0": false,
  no: false,
  false: false,
  off: false,
};

/** `RawConfigParser.getboolean` : la valeur (non nettoyée des blancs internes) en minuscules. */
export function pyBoolean(text: string): boolean | undefined {
  return BOOLEANS[text.toLowerCase()];
}

export type ListParser = "string" | "int" | "float";

export type ListResult =
  | { readonly ok: true; readonly values: readonly unknown[] }
  | { readonly ok: false; readonly reason: "parse" | "count"; readonly count?: number };

/** `getlists` : découpe par séparateurs (le dernier est le plus externe), nombre d'éléments. */
export function pyLists(
  text: string,
  seps: readonly string[],
  parser: ListParser,
  count?: number,
): ListResult {
  let failure: ListResult | undefined;
  const parse = (value: string, position: number): unknown[] => {
    const parts = pyStrip(value) === "" ? [] : value.split(seps[position] ?? ",").map(pyStrip);
    if (position > 0) return parts.filter((p) => p !== "").map((p) => parse(p, position - 1));
    const items = parts.map((part) => {
      if (parser === "string") return part;
      const number = parser === "int" ? pyInt(part) : pyFloat(part);
      if (number === undefined) failure ??= { ok: false, reason: "parse" };
      return number;
    });
    if (count !== undefined && items.length !== count)
      failure ??= { ok: false, reason: "count", count };
    return items;
  };
  const values = parse(text, seps.length - 1);
  return failure ?? { ok: true, values };
}
