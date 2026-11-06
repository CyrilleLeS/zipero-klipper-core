// SPDX-License-Identifier: GPL-3.0-only

import { REFERENCE_PRINTERS, type ReferencePrinter } from "./reference";

/**
 * Texte complet de la configuration d'origine d'un modèle (EP-06.11, comparaison). Données
 * générées (`reference-configs.json`, voir tooling/corpus-tests) : seules les configurations sous
 * GPL-3.0 sont publiées (la configuration Qidi, sous AGPL-3.0, ne l'est pas). Chargées à la
 * demande : aucun poids au chargement des pages.
 */

/** Modèles dont le texte d'origine est publié. */
export const COMPARABLE_PRINTERS: readonly ReferencePrinter[] = REFERENCE_PRINTERS.filter(
  (printer) => printer.source.license === "GPL-3.0-only",
);

export async function loadReferenceConfig(id: string): Promise<string | undefined> {
  if (!COMPARABLE_PRINTERS.some((printer) => printer.id === id)) return undefined;
  const { default: configs } = await import("./reference-configs.json", {
    with: { type: "json" },
  });
  return (configs as readonly { id: string; text: string }[]).find((c) => c.id === id)?.text;
}
