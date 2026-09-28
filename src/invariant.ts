// SPDX-License-Identifier: GPL-3.0-only

/**
 * Garantit qu'une valeur existe là où la logique l'assure déjà (index dans les bornes, groupe
 * de regex obligatoire…). Évite de disperser des replis `?? 0` qui masqueraient un bug.
 */
export function defined<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`Invariant violé : ${what} absent.`);
  return value;
}
