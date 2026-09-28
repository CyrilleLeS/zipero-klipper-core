// SPDX-License-Identifier: GPL-3.0-only

/**
 * Résultat d'une analyse. Le cœur ne produit jamais de texte destiné à l'utilisateur :
 * uniquement des codes stables et des paramètres, traduits par l'interface (i18n).
 */
export interface Issue<Code extends string = string> {
  readonly code: Code;
  /** Ligne concernée dans le texte source (à partir de 1), si pertinente. */
  readonly line?: number;
  readonly params?: Readonly<Record<string, string | number>>;
}

export type ParseResult<T, Code extends string = string> =
  | { readonly ok: true; readonly value: T; readonly warnings: readonly Issue<Code>[] }
  | { readonly ok: false; readonly error: Issue<Code>; readonly warnings: readonly Issue<Code>[] };

export function success<T, Code extends string>(
  value: T,
  warnings: readonly Issue<Code>[] = [],
): ParseResult<T, Code> {
  return { ok: true, value, warnings };
}

export function failure<T, Code extends string>(
  error: Issue<Code>,
  warnings: readonly Issue<Code>[] = [],
): ParseResult<T, Code> {
  return { ok: false, error, warnings };
}
