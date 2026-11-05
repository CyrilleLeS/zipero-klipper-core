// SPDX-License-Identifier: GPL-3.0-only

import { failure, type ParseResult, success } from "../result";

/**
 * `rotation_distance` de l'extrudeur par « mesurer et ajuster » (EP-24.06), selon la documentation
 * de Klipper (`docs/Rotation_Distance.md`, section « Calibrating rotation_distance on extruders »,
 * commit 214fdb2877) :
 * - distance réellement extrudée = repère avant − repère après (mesurés depuis le corps de
 *   l'extrudeur) ;
 * - nouvelle valeur = ancienne × distance réellement extrudée / distance demandée, arrondie à
 *   trois décimales ;
 * - un écart de plus d'environ 2 mm entre l'extrudé réel et le demandé : refaire la mesure.
 */

/** Écart (mm) au-delà duquel Klipper conseille de refaire la mesure. */
export const ROTATION_REMEASURE_MM = 2;

export const ROTATION_DISTANCE_CODES = [
  "rotation.invalid-previous",
  "rotation.invalid-requested",
  "rotation.invalid-mark",
  "rotation.not-extruded",
  "rotation.remeasure",
] as const;
export type RotationDistanceCode = (typeof ROTATION_DISTANCE_CODES)[number];

export interface RotationDistanceInput {
  /** `rotation_distance` actuelle de la section `[extruder]` (mm). */
  readonly previous: number;
  /** Longueur demandée à l'extrudeur (mm ; 50 dans la procédure de Klipper). */
  readonly requested: number;
  /** Distance du repère au corps de l'extrudeur avant l'extrusion (mm). */
  readonly markBefore: number;
  /** Même distance après l'extrusion (mm). */
  readonly markAfter: number;
}

export interface RotationDistanceResult {
  /** Filament réellement entré (mm). */
  readonly actual: number;
  /** Écart réel − demandé (mm) : négatif quand l'extrudeur pousse moins que demandé. */
  readonly deviation: number;
  /** Nouvelle `rotation_distance`, arrondie à trois décimales. */
  readonly value: number;
}

const positive = (value: number) => Number.isFinite(value) && value > 0;

/** Arrondi à trois décimales, sans l'erreur binaire de `toFixed` (1,0005 → 1,001). */
export const roundTo3 = (value: number) => Math.round((value + Number.EPSILON) * 1000) / 1000;

export function computeRotationDistance(
  input: RotationDistanceInput,
): ParseResult<RotationDistanceResult, RotationDistanceCode> {
  if (!positive(input.previous)) return failure({ code: "rotation.invalid-previous" });
  if (!positive(input.requested)) return failure({ code: "rotation.invalid-requested" });
  if (!Number.isFinite(input.markBefore) || !Number.isFinite(input.markAfter)) {
    return failure({ code: "rotation.invalid-mark" });
  }
  if (input.markAfter < 0) return failure({ code: "rotation.invalid-mark" });
  const actual = input.markBefore - input.markAfter;
  if (actual <= 0) return failure({ code: "rotation.not-extruded" });
  const deviation = actual - input.requested;
  const value = roundTo3((input.previous * actual) / input.requested);
  const warnings =
    Math.abs(deviation) > ROTATION_REMEASURE_MM
      ? [{ code: "rotation.remeasure" as const, params: { deviation: roundTo3(deviation) } }]
      : [];
  return success({ actual: roundTo3(actual), deviation: roundTo3(deviation), value }, warnings);
}

/**
 * Bloc à coller dans `printer.cfg` : la section de l'extrudeur réglé (`extruder`, `extruder1`…)
 * et la nouvelle valeur, point décimal comme Klipper l'attend.
 */
export function rotationDistanceSnippet(value: number, section = "extruder"): string {
  return `[${section}]\nrotation_distance: ${roundTo3(value).toFixed(3)}`;
}
