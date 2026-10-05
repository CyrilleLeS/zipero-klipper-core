// SPDX-License-Identifier: GPL-3.0-only

/**
 * Rôle d'une ligne d'extrusion (EP-04.06), d'après les commentaires des slicers : `;TYPE:` de
 * PrusaSlicer, SuperSlicer, OrcaSlicer et Cura, `; FEATURE:` de Bambu Studio. Indice stable :
 * stocké sur un octet par segment.
 */
export const GCODE_ROLES = [
  "other",
  "outer-wall",
  "inner-wall",
  "overhang-wall",
  "infill",
  "solid-infill",
  "top-surface",
  "bottom-surface",
  "bridge",
  "gap-fill",
  "skirt",
  "support",
  "support-interface",
  "ironing",
  "prime-tower",
] as const;

export type GcodeRole = (typeof GCODE_ROLES)[number];

const ROLE_INDEX = new Map<string, number>(GCODE_ROLES.map((role, index) => [role, index]));

/** Noms des slicers (minuscules, espaces et tirets réduits) → rôle. */
const NAMES: Record<string, GcodeRole> = {
  // PrusaSlicer, SuperSlicer.
  "external perimeter": "outer-wall",
  perimeter: "inner-wall",
  "overhang perimeter": "overhang-wall",
  "internal infill": "infill",
  "solid infill": "solid-infill",
  "top solid infill": "top-surface",
  "bridge infill": "bridge",
  "internal bridge infill": "bridge",
  "gap fill": "gap-fill",
  "skirt/brim": "skirt",
  "support material": "support",
  "support material interface": "support-interface",
  "wipe tower": "prime-tower",
  // OrcaSlicer, Bambu Studio.
  "outer wall": "outer-wall",
  "inner wall": "inner-wall",
  "overhang wall": "overhang-wall",
  "sparse infill": "infill",
  "internal solid infill": "solid-infill",
  "top surface": "top-surface",
  "bottom surface": "bottom-surface",
  bridge: "bridge",
  "gap infill": "gap-fill",
  skirt: "skirt",
  brim: "skirt",
  support: "support",
  "support interface": "support-interface",
  "support transition": "support",
  ironing: "ironing",
  "prime tower": "prime-tower",
  // Cura.
  "wall outer": "outer-wall",
  "wall inner": "inner-wall",
  skin: "solid-infill",
  fill: "infill",
};

/** Indice du rôle pour un nom de slicer ; « other » si inconnu. */
export function roleIndex(name: string): number {
  const key = name
    .trim()
    .toLowerCase()
    .replace(/[-_\s]+/g, " ");
  const role = NAMES[key] ?? "other";
  return ROLE_INDEX.get(role) ?? 0;
}
