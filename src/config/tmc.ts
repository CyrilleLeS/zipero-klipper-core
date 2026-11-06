// SPDX-License-Identifier: GPL-3.0-only
import type { Issue } from "../result";
import type { ConfigSection } from "./ini";
import { parsePin } from "./pins";
import { pyFloat } from "./values";

/**
 * Contrôles des pilotes TMC (EP-06.06), d'après le code de Klipper (klippy/extras/tmc*.py) et sa
 * documentation (docs/TMC_Drivers.md), commit 214fdb2877. Les limites que Klipper vérifie à la
 * lecture (`maxval`, `above`) sont déjà contrôlées par le schéma ; ici :
 * - courant demandé au-delà de ce que le pilote produit avec son `sense_resistor` : Klipper borne
 *   le réglage du pilote (`cs`, de 0 à 31) et applique le maximum, sans message ;
 * - TMC2240 : maximum calculé depuis `rref`, refusé par Klipper au démarrage (le schéma ne le
 *   connaît pas, la limite étant calculée) ;
 * - homing sans capteur (`endstop_pin: tmcXXXX_stepper:virtual_endstop`) : pilote qui n'en a pas,
 *   broche diag absente (refusé par Klipper), et les réglages que la documentation exige.
 * Établi sur le code de Klipper seul : à n'appliquer qu'au firmware « klipper » (les versions
 * modifiées, Kalico, Creality, Qidi…, peuvent différer). Vérifié sur le corpus (629 fichiers).
 */

export const TMC_CODES = [
  "tmc.current-capped",
  "tmc.current-above-max",
  "tmc.virtual-endstop-unsupported",
  "tmc.diag-pin-missing",
  "tmc.sensorless-retract",
  "tmc.sensorless-hold-current",
  "tmc.sgthrs-default",
] as const;
export type TmcCode = (typeof TMC_CODES)[number];

export interface TmcIssue extends Issue<TmcCode> {
  readonly severity: "error" | "warning" | "info";
  readonly file: string;
  readonly line: number;
  readonly section: string;
}

/**
 * Courant efficace maximal (A) que le pilote produit, `cs` = 31 (formules de Klipper) :
 * - tmc2130.py (TMC2130, TMC2208, TMC2209) : vref 0,32 V (vsense désactivé), résistance + 0,020 Ω ;
 * - tmc2660.py : vref 0,310 V, sans résistance ajoutée ;
 * - tmc5160.py : VREF 0,325 V, globalscaler 256.
 */
const SENSE_DRIVERS = {
  tmc2130: { defaultResistor: 0.11, max: (r: number) => 0.32 / ((r + 0.02) * Math.SQRT2) },
  tmc2208: { defaultResistor: 0.11, max: (r: number) => 0.32 / ((r + 0.02) * Math.SQRT2) },
  tmc2209: { defaultResistor: 0.11, max: (r: number) => 0.32 / ((r + 0.02) * Math.SQRT2) },
  tmc2660: { defaultResistor: undefined, max: (r: number) => 0.31 / (r * Math.SQRT2) },
  tmc5160: { defaultResistor: 0.075, max: (r: number) => 0.325 / (r * Math.SQRT2) },
} as const;

/** tmc2240.py : courant maximal accepté, `KIFS[3]` / `rref` / √2 (rref : 12 000 Ω par défaut). */
const TMC2240_DEFAULT_RREF = 12_000;
const tmc2240Max = (rref: number) => 36_000 / rref / Math.SQRT2;

/** Pilotes qui enregistrent une butée virtuelle (TMCVirtualPinHelper). */
const VIRTUAL_ENDSTOP = new Set(["tmc2130", "tmc2209", "tmc2240", "tmc5160"]);
/** Pilotes à deux broches de diagnostic (registre `diag0_stall`) : `diag0_pin` ou `diag1_pin`. */
const TWO_DIAG = new Set(["tmc2130", "tmc2240", "tmc5160"]);

/** Écart (A) en dessous duquel un courant plafonné ne vaut pas d'être signalé (arrondi). */
const CAPPED_TOLERANCE = 0.01;

const round3 = (value: number) => Math.round(value * 1000) / 1000;

export function checkTmc(sections: readonly ConfigSection[]): TmcIssue[] {
  const issues: TmcIssue[] = [];
  // Carte virtuelle d'un pilote : premier et dernier mot de sa section, comme
  // `register_chip("%s_%s" % (name_parts[0], name_parts[-1]))` dans tmc.py.
  const byChip = new Map<string, ConfigSection>(
    sections
      .filter((s) => /^tmc\d{4}\s/.test(s.name))
      .map((s): [string, ConfigSection] => {
        const parts = s.name.split(/\s+/);
        return [`${parts[0]}_${parts.at(-1)}`, s];
      }),
  );

  for (const section of sections) {
    const match = /^(tmc\d{4})\s+(.+)$/.exec(section.name);
    if (!match) continue;
    const driver = match[1] as string;
    const run = section.options.get("run_current");
    const runCurrent = run ? pyFloat(run.value) : undefined;
    if (!run || runCurrent === undefined || !(runCurrent > 0)) continue;
    const where = { file: run.file, line: run.line, section: section.name };

    if (driver in SENSE_DRIVERS) {
      const spec = SENSE_DRIVERS[driver as keyof typeof SENSE_DRIVERS];
      const declared = section.options.get("sense_resistor");
      const resistor = declared ? pyFloat(declared.value) : spec.defaultResistor;
      // Résistance absente sans valeur par défaut (TMC2660) ou invalide : déjà signalée.
      if (resistor === undefined || !(resistor > 0)) continue;
      const max = spec.max(resistor);
      if (runCurrent - max > CAPPED_TOLERANCE) {
        issues.push({
          code: "tmc.current-capped",
          severity: "warning",
          ...where,
          params: {
            driver,
            requested: runCurrent,
            max: round3(max),
            resistor,
            declared: declared ? "yes" : "no",
          },
        });
      }
    } else if (driver === "tmc2240") {
      const rrefOption = section.options.get("rref");
      const rref = rrefOption ? pyFloat(rrefOption.value) : TMC2240_DEFAULT_RREF;
      // rref hors de 12 000 à 60 000 : refusé par Klipper, déjà signalé par le schéma.
      if (rref === undefined || rref < 12_000 || rref > 60_000) continue;
      const max = tmc2240Max(rref);
      for (const name of ["run_current", "hold_current"] as const) {
        const option = section.options.get(name);
        const value = option ? pyFloat(option.value) : undefined;
        if (!option || value === undefined || value <= max) continue;
        issues.push({
          code: "tmc.current-above-max",
          severity: "error",
          file: option.file,
          line: option.line,
          section: section.name,
          params: { driver, option: name, requested: value, max: round3(max), rref },
        });
      }
    }
  }

  // Homing sans capteur : chaque `endstop_pin` qui désigne la butée virtuelle d'un TMC.
  for (const stepper of sections) {
    const endstop = stepper.options.get("endstop_pin");
    const pin = endstop ? parsePin(endstop.value) : null;
    if (!endstop || !pin || pin.pin !== "virtual_endstop") continue;
    const tmc = byChip.get(pin.chip);
    const driver = tmc?.name.split(/\s+/)[0];
    // Section du pilote absente : carte inconnue, déjà signalée par le contrôle des broches.
    if (!tmc || !driver) continue;
    const at = { file: endstop.file, line: endstop.line, section: stepper.name };
    if (!VIRTUAL_ENDSTOP.has(driver)) {
      issues.push({
        code: "tmc.virtual-endstop-unsupported",
        severity: "error",
        ...at,
        params: { driver, chip: pin.chip },
      });
      continue;
    }
    const diagOptions = TWO_DIAG.has(driver) ? ["diag0_pin", "diag1_pin"] : ["diag_pin"];
    if (!diagOptions.some((name) => tmc.options.has(name))) {
      issues.push({
        code: "tmc.diag-pin-missing",
        severity: "error",
        file: tmc.file,
        line: tmc.line,
        section: tmc.name,
        params: { driver, options: diagOptions.join(" / "), stepper: stepper.name },
      });
    }
    // Valeur par défaut de Klipper : 5 mm (Config_Reference.md). Illisible : déjà signalée.
    const retract = stepper.options.get("homing_retract_dist");
    const distance = retract ? pyFloat(retract.value) : 5;
    if (distance !== undefined && distance !== 0) {
      issues.push({
        code: "tmc.sensorless-retract",
        severity: "warning",
        ...(retract ? { file: retract.file, line: retract.line, section: stepper.name } : at),
        params: { distance, declared: retract ? "yes" : "no" },
      });
    }
    const hold = tmc.options.get("hold_current");
    if (hold) {
      issues.push({
        code: "tmc.sensorless-hold-current",
        // Conseil : la documentation le demande surtout pendant le réglage de la sensibilité, et
        // des machines d'usine fonctionnent avec (Creality K1, Sovol SV08, Prusa MK3).
        severity: "info",
        file: hold.file,
        line: hold.line,
        section: tmc.name,
        params: { stepper: stepper.name },
      });
    }
    if (driver === "tmc2209" && !tmc.options.has("driver_sgthrs")) {
      issues.push({
        code: "tmc.sgthrs-default",
        severity: "warning",
        file: tmc.file,
        line: tmc.line,
        section: tmc.name,
        params: { stepper: stepper.name },
      });
    }
  }
  return issues;
}
