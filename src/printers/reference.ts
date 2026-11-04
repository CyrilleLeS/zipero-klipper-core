// SPDX-License-Identifier: GPL-3.0-only

import type { PrinterMechanics } from "./extract";
import klipper from "./klipper-reference.json" with { type: "json" };
import makers from "./maker-reference.json" with { type: "json" };

/**
 * Profils de référence extraits des configurations officielles de Klipper (EP-11.07), puis de
 * celles des fabricants pour les machines absentes de Klipper (Voron 2.4, Creality K1, Sovol SV08,
 * Qidi Plus4). Données générées (voir tooling/corpus-tests) : NE PAS modifier
 * `klipper-reference.json` ni `maker-reference.json` à la main. Chaque profil cite sa source
 * exacte (dépôt, commit, fichier, licence).
 */
export interface ReferencePrinter {
  /** Identifiant stable (nom du fichier de configuration sans préfixe ni extension). */
  readonly id: string;
  readonly name: string;
  /** Année indiquée par le nom du fichier de Klipper (absente des profils des fabricants). */
  readonly year?: number;
  readonly mechanics: PrinterMechanics;
  readonly source: {
    readonly repository: string;
    readonly commit: string;
    readonly path: string;
    readonly license: string;
  };
}

export const REFERENCE_PRINTERS: readonly ReferencePrinter[] = [
  ...(klipper as unknown as ReferencePrinter[]),
  ...(makers as unknown as ReferencePrinter[]),
];

export function findReferencePrinter(id: string): ReferencePrinter | undefined {
  return REFERENCE_PRINTERS.find((printer) => printer.id === id);
}
