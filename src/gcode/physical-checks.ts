// SPDX-License-Identifier: GPL-3.0-only
import { extendedParams } from "../macros/semantics";
import type { Travel } from "../printers/extract";
import type { GcodeCheck, GcodeFacts } from "./klipper-checks";
import type { GcodeMetadata } from "./metadata";
import type { GcodeToolpath } from "./parse";

/**
 * Règles physiques d'un G-code (EP-04.11) : ce que la machine ou le matériau ne suivront pas.
 * - première couche trop rapide : au-delà de 60 mm/s (vitesse atteinte par 5 % du chemin le plus
 *   rapide), l'adhérence de la première couche se dégrade ;
 * - débit volumétrique au-delà de la capacité déclarée (`filament_max_volumetric_speed` du
 *   trancheur) pendant plus de 5 % du temps d'extrusion : sous-extrusion ;
 * - extrusion hors de la course des axes (configuration jointe ou « Mon imprimante ») : Klipper
 *   refuse le mouvement (« Move out of range ») et l'impression s'arrête ;
 * - températures hors des plages usuelles du matériau déclaré.
 *
 * Plages de température : tableau des matériaux de Prusa Research (help.prusa3d.com, « Filament
 * Material Guide »), 150 filaments du commerce relevés le 07/10/2026 ; plage = minimum et maximum
 * des filaments du matériau, pour les matériaux qui en comptent au moins 4. Tolérance de 10 °C
 * pour la buse et de 15 °C pour le plateau.
 */

/** Plages relevées (°C) : buse, puis plateau. */
export const MATERIAL_TEMPERATURES: Readonly<
  Record<
    string,
    { readonly nozzle: readonly [number, number]; readonly bed: readonly [number, number] }
  >
> = {
  PLA: { nozzle: [185, 230], bed: [55, 60] },
  PETG: { nozzle: [215, 270], bed: [70, 90] },
  ABS: { nozzle: [230, 255], bed: [95, 110] },
  ASA: { nozzle: [220, 275], bed: [90, 110] },
  PA: { nozzle: [240, 285], bed: [70, 115] },
  PC: { nozzle: [270, 275], bed: [105, 115] },
  TPU: { nozzle: [220, 260], bed: [40, 85] },
};

const NOZZLE_TOLERANCE = 10;
const BED_TOLERANCE = 15;
const FIRST_LAYER_MAX_SPEED = 60;
const FLOW_SHARE = 0.05;

/** Nom du matériau déclaré par le trancheur → clé du tableau (`PET`, `PA12-CF`, `FLEX`…). */
export function materialOf(filamentType: string | undefined): string | undefined {
  const type = filamentType?.toUpperCase().trim();
  if (!type) return undefined;
  if (/^PLA\b/.test(type)) return "PLA";
  if (/^PETG|^PET\b/.test(type)) return "PETG";
  if (/^ABS\b/.test(type)) return "ABS";
  if (/^ASA\b/.test(type)) return "ASA";
  if (/^(PA|NYLON)/.test(type)) return "PA";
  if (/^PC\b/.test(type)) return "PC";
  if (/^(TPU|TPE|FLEX)/.test(type)) return "TPU";
  return undefined;
}

export interface PhysicalContext {
  /** Course des axes de l'imprimante (configuration jointe, sinon modèle de « Mon imprimante »). */
  readonly travel?: Travel | undefined;
}

/** Lecture d'un indice dans les bornes (boucles sur des tableaux de même longueur). */
const at = (array: ArrayLike<number>, index: number) => array[index] as number;

/** Quantile pondéré : valeur atteinte ou dépassée par la part `share` du poids total. */
function weightedTop(values: readonly number[], weights: readonly number[], share: number): number {
  const order = values.map((_, i) => i).sort((a, b) => at(values, b) - at(values, a));
  const total = weights.reduce((sum, w) => sum + w, 0);
  let acc = 0;
  for (const i of order) {
    acc += at(weights, i);
    if (acc >= total * share) return at(values, i);
  }
  return 0;
}

/** Paramètres de macro qui portent une température (noms usuels des G-code de début). */
const NOZZLE_PARAM =
  /^(EXTRUDER|EXTRUDER_TEMP|EXTRUDER_TEMPERATURE|HOTEND|HOTEND_TEMP|NOZZLE|NOZZLE_TEMP|TOOL_TEMP)$/;
const BED_PARAM = /^(BED|BED_TEMP|BED_TEMPERATURE|BEDTEMP)$/;

function startTemperatures(facts: GcodeFacts): { nozzle?: number; bed?: number } {
  const nozzle: number[] = [];
  const bed: number[] = [];
  for (const t of facts.startTemperatures) {
    if (t.target <= 0) continue;
    (t.command === "M104" || t.command === "M109" ? nozzle : bed).push(t.target);
  }
  for (const call of facts.startCalls) {
    for (const [key, value] of Object.entries(extendedParams(call.raw, call.command) ?? {})) {
      const number = Number(value);
      if (!Number.isFinite(number) || number <= 0) continue;
      if (NOZZLE_PARAM.test(key)) nozzle.push(number);
      else if (BED_PARAM.test(key)) bed.push(number);
    }
  }
  return {
    ...(nozzle.length ? { nozzle: Math.max(...nozzle) } : {}),
    ...(bed.length ? { bed: Math.max(...bed) } : {}),
  };
}

export function checkPhysics(
  toolpath: GcodeToolpath,
  metadata: GcodeMetadata,
  facts: GcodeFacts,
  context: PhysicalContext = {},
): GcodeCheck[] {
  const checks: GcodeCheck[] = [];
  const { positions, feedrates, extrusions } = toolpath;
  const length = (i: number) =>
    Math.hypot(
      at(positions, i * 6 + 3) - at(positions, i * 6),
      at(positions, i * 6 + 4) - at(positions, i * 6 + 1),
      at(positions, i * 6 + 5) - at(positions, i * 6 + 2),
    );

  // Première couche : vitesse atteinte par les 5 % du chemin le plus rapide.
  const firstEnd = toolpath.layerStarts[1] ?? toolpath.segments;
  const speeds: number[] = [];
  const lengths: number[] = [];
  for (let i = at(toolpath.layerStarts, 0); i < firstEnd; i++) {
    const l = length(i);
    if (l <= 0 || at(extrusions, i) <= 0) continue;
    speeds.push(at(feedrates, i));
    lengths.push(l);
  }
  const firstLayerSpeed = speeds.length ? weightedTop(speeds, lengths, 0.05) : 0;
  if (firstLayerSpeed > FIRST_LAYER_MAX_SPEED) {
    checks.push({
      code: "gcode.first-layer-fast",
      severity: "warning",
      params: { speed: Math.round(firstLayerSpeed), limit: FIRST_LAYER_MAX_SPEED },
    });
  }

  // Débit volumétrique, comparé à la capacité déclarée par le trancheur.
  const capacity = metadata.maxVolumetricSpeed;
  if (capacity !== undefined && toolpath.segments > 0) {
    const radius = (metadata.filamentDiameter ?? 1.75) / 2;
    const area = Math.PI * radius * radius;
    const flows: number[] = [];
    const times: number[] = [];
    let over = 0;
    let total = 0;
    for (let i = 0; i < toolpath.segments; i++) {
      const l = length(i);
      const speed = at(feedrates, i);
      const e = at(extrusions, i);
      if (l <= 0 || speed <= 0 || e <= 0) continue;
      const time = l / speed;
      const flow = (e * area) / time;
      flows.push(flow);
      times.push(time);
      total += time;
      if (flow > capacity * 1.05) over += time;
    }
    if (total > 0 && over / total > FLOW_SHARE) {
      checks.push({
        code: "gcode.flow-over-capacity",
        severity: "warning",
        params: {
          flow: Math.round(weightedTop(flows, times, 0.05) * 10) / 10,
          capacity,
          share: Math.round((over / total) * 100),
        },
      });
    }
  }

  // Extrusion hors de la course des axes.
  const travel = context.travel;
  if (travel && toolpath.segments > 0) {
    const [minX, minY, , maxX, maxY, maxZ] = toolpath.bounds;
    const bounds: [string, "min" | "max", number, number | undefined][] = [
      ["X", "min", minX, travel.minX],
      ["X", "max", maxX, travel.maxX],
      ["Y", "min", minY, travel.minY],
      ["Y", "max", maxY, travel.maxY],
      ["Z", "max", maxZ, travel.maxZ],
    ];
    for (const [axis, side, value, limit] of bounds) {
      if (limit === undefined) continue;
      const outside = side === "min" ? value < limit - 0.01 : value > limit + 0.01;
      if (outside) {
        checks.push({
          code: "gcode.out-of-volume",
          severity: "error",
          params: { axis, side, value: Math.round(value * 10) / 10, limit },
        });
      }
    }
  }

  // Températures et matériau déclaré.
  const material = materialOf(metadata.filamentType);
  const range = material ? MATERIAL_TEMPERATURES[material] : undefined;
  if (material && range) {
    const temps = startTemperatures(facts);
    const [nozzleMin, nozzleMax] = range.nozzle;
    if (
      temps.nozzle !== undefined &&
      (temps.nozzle < nozzleMin - NOZZLE_TOLERANCE || temps.nozzle > nozzleMax + NOZZLE_TOLERANCE)
    ) {
      checks.push({
        code: "gcode.nozzle-temp-material",
        severity: "warning",
        params: { material, temperature: temps.nozzle, min: nozzleMin, max: nozzleMax },
      });
    }
    const [bedMin, bedMax] = range.bed;
    if (
      temps.bed !== undefined &&
      (temps.bed < bedMin - BED_TOLERANCE || temps.bed > bedMax + BED_TOLERANCE)
    ) {
      checks.push({
        code: "gcode.bed-temp-material",
        severity: "info",
        params: { material, temperature: temps.bed, min: bedMin, max: bedMax },
      });
    }
  }

  return checks;
}
