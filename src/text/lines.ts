// SPDX-License-Identifier: GPL-3.0-only

/** Une ligne de texte source, avec son numéro (à partir de 1) dans le fichier d'origine. */
export interface SourceLine {
  readonly line: number;
  readonly text: string;
}

/**
 * Découpe un texte en lignes numérotées, quel que soit le format de fin de ligne
 * (LF, CRLF ou CR seul). Le BOM UTF-8 éventuel est retiré. Tous les parseurs du cœur
 * s'appuient sur cette fonction pour rapporter des numéros de ligne exacts.
 */
export function splitLines(source: string): SourceLine[] {
  const text = source.startsWith("\uFEFF") ? source.slice(1) : source;
  if (text === "") return [];
  const parts = text.split(/\r\n|\r|\n/);
  // Une fin de ligne finale ne crée pas de ligne vide supplémentaire.
  if (parts.at(-1) === "") parts.pop();
  return parts.map((content, index) => ({ line: index + 1, text: content }));
}
