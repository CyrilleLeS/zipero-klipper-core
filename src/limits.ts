// SPDX-License-Identifier: GPL-3.0-only

/**
 * Limites de calcul du cœur (EP-16.02). Klipper ne borne ni `probe_count` ni `mesh_pps` : une
 * configuration hostile ou fautive (`probe_count: 100000, 100000`) ferait générer des milliards
 * de points et épuiserait la mémoire de l'onglet (constaté : 4 Go atteints en 20 s). Au-delà de
 * ces seuils, très loin des maillages réels (50 × 50 pour les sondes à balayage), le calcul
 * concerné est sauté et signalé ; le reste de l'analyse continue.
 */
export const ANALYSIS_LIMITS = {
  /** Points de palpage générés depuis `probe_count` (500 × 500). */
  maxProbePoints: 250_000,
  /** Cases de la surface interpolée (1 000 × 1 000). */
  maxInterpolatedPoints: 1_000_000,
} as const;
