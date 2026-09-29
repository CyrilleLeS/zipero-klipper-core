// SPDX-License-Identifier: GPL-3.0-only
import klipper214 from "./schema/klipper-214fdb2877.json" with { type: "json" };
import type { ConfigSchema } from "./validate";

/**
 * Schémas des options par firmware et par commit (ADR 0022), générés par
 * scripts/schema/generate.py depuis le code de Klipper : NE PAS modifier les JSON à la main.
 */
export const KLIPPER_SCHEMA: ConfigSchema = klipper214 as ConfigSchema;
