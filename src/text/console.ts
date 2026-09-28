// SPDX-License-Identifier: GPL-3.0-only
import { type SourceLine, splitLines } from "./lines";

/**
 * Ligne de console nettoyée : les ajouts des interfaces (horodatage de Mainsail, Fluidd ou
 * KlipperScreen, préfixes `Recv:`/`Send:` d'OctoPrint, `echo:`) et le préfixe `// ` que Klipper
 * ajoute aux messages d'information (`respond_info`) sont retirés.
 */
export interface ConsoleLine extends SourceLine {
  /** Contenu utile, sans préfixes ni espaces de bord. */
  readonly content: string;
}

// Formats relevés dans de vrais collages (corpus, tickets GitHub publics) :
// - citation Markdown (copie depuis un forum, un ticket, Discord) : « > », « > > », « >>> » ;
// - code en ligne Markdown : « `…` » ;
// - horodatages : 12:03, 12:03:45(.123), [12:03:45], 2026-09-28 12:03:45,
//   journal OctoPrint « [2020-04-16 09:01:24,376] DEBUG: » ou « 2020-04-16 09:01:24,376 - »,
//   temps relatif « 0:00:13.539: », console « 1/12/2021, 12:54:08 PM | ».
const QUOTE = /^(?:>\s*)+/;
const INLINE_CODE = /^`+|`+$/g;
const TIMESTAMP =
  /^\[?(?:\d{4}-\d{2}-\d{2}[ T]|\d{1,2}\/\d{1,2}\/\d{2,4},?\s+)?\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:\s*[AP]M)?\]?:?\s*(?:[|-]\s+)?/i;
const LOG_LEVEL = /^(?:DEBUG|INFO|WARNING|ERROR)\s*[:-]\s*/;
const HOST_PREFIX = /^(?:Recv|Send|echo):\s*/i;
const KLIPPER_INFO = /^\/\/\s?/;

export function cleanConsoleLine(text: string): string {
  let content = text.trim();
  // Les préfixes se combinent (« > 12:03:45 Recv: // … ») : on les retire dans l'ordre.
  content = content.replace(QUOTE, "").trim();
  content = content.replace(INLINE_CODE, "").trim();
  content = content.replace(TIMESTAMP, "");
  content = content.replace(LOG_LEVEL, "");
  content = content.replace(HOST_PREFIX, "");
  content = content.replace(KLIPPER_INFO, "");
  return content.trim();
}

export function consoleLines(source: string): ConsoleLine[] {
  return splitLines(source).map((line) => ({ ...line, content: cleanConsoleLine(line.text) }));
}

const NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

/**
 * Lit une ligne composée uniquement de nombres (séparés par espaces, tabulations et/ou
 * virgules). Renvoie `null` si la ligne contient autre chose.
 */
export function parseNumberRow(content: string): number[] | null {
  const tokens = content.split(/[\s,]+/).filter((token) => token !== "");
  if (tokens.length === 0 || !tokens.every((token) => NUMBER.test(token))) return null;
  return tokens.map(Number);
}
