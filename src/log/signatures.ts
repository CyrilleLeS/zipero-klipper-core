// SPDX-License-Identifier: GPL-3.0-only

/**
 * Signatures d'erreurs du `klippy.log` (EP-07.04, ADR 0032) : des données, comme les règles de la
 * configuration (ADR 0025). Une signature reconnaît une ligne du journal (un texte littéral, puis
 * une expression régulière dont les groupes nommés deviennent des paramètres) ; ses textes
 * (cause, vérifications, correctif, pièces) voyagent avec elle. Aucun code n'est exécuté.
 */

export interface LogSignatureTexts {
  readonly title: string;
  /** Cause probable, en une ou deux phrases. */
  readonly cause: string;
  /** Vérifications, dans l'ordre où les faire. */
  readonly checks: readonly string[];
  /** Correctif le plus fréquent. */
  readonly fix: string;
  /** Pièces en cause (câble, sonde, pilote…). */
  readonly parts?: readonly string[];
}

export interface LogSignature {
  readonly id: string;
  readonly severity: "error" | "warning" | "info";
  /** Texte littéral présent dans toute ligne reconnue : filtre rapide avant l'expression. */
  readonly contains: string;
  /** Expression régulière sur la ligne ; groupes nommés : paramètres des textes (`{nom}`). */
  readonly pattern: string;
  /** Textes par langue ; `fr` obligatoire. */
  readonly texts: Readonly<Record<string, LogSignatureTexts>>;
  /** Produits liés (EP-11, affiliation) : identifiants du catalogue. */
  readonly products?: readonly string[];
  /** Le message vérifié dans le code de Klipper : fichier et extrait. */
  readonly source: string;
}

/** Problème reconnu dans une session : première occurrence, nombre d'occurrences. */
export interface LogProblem {
  readonly id: string;
  readonly severity: LogSignature["severity"];
  /** Ligne de la première occurrence (1 = première ligne du fichier). */
  readonly line: number;
  readonly count: number;
  /**
   * true : une occurrence a arrêté l'imprimante (`Transition to shutdown state`) ou fait échouer
   * le chargement de la configuration (pile qui suit `Config error`).
   */
  readonly stopped: boolean;
  /** Paramètres tirés de la première occurrence. */
  readonly params: Readonly<Record<string, string>>;
}

/** Longueur de ligne examinée : une ligne de statistiques démesurée ne coûte rien de plus. */
const MAX_LINE = 2000;

export interface LogMatch {
  readonly signature: LogSignature;
  readonly params: Readonly<Record<string, string>>;
}

/**
 * Prépare les signatures ; la fonction rendue donne la première qui reconnaît la ligne (l'ordre
 * du paquet compte : les plus précises d'abord). Une expression invalide est écartée.
 */
export function compileSignatures(
  signatures: readonly LogSignature[],
): (line: string) => LogMatch | undefined {
  const compiled: { signature: LogSignature; regex: RegExp }[] = [];
  for (const signature of signatures) {
    try {
      compiled.push({ signature, regex: new RegExp(signature.pattern) });
    } catch {
      // Paquet distant d'une version plus récente : la signature est ignorée, pas le journal.
    }
  }
  return (raw) => {
    const line = raw.length > MAX_LINE ? raw.slice(0, MAX_LINE) : raw;
    for (const { signature, regex } of compiled) {
      if (!line.includes(signature.contains)) continue;
      const match = regex.exec(line);
      if (!match) continue;
      const params: Record<string, string> = {};
      for (const [name, value] of Object.entries(match.groups ?? {})) {
        if (value !== undefined) params[name] = value.trim().slice(0, 200);
      }
      return { signature, params };
    }
    return undefined;
  };
}
