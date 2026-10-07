// SPDX-License-Identifier: GPL-3.0-only
import type { Issue } from "../result";
import type { ConfigOption, ConfigSection } from "./ini";
import pinsKlipper from "./pins/klipper-214fdb2877.json" with { type: "json" };

/**
 * Contrôle des broches (EP-06.04), comme Klipper au démarrage (klippy/pins.py, mcu.py) :
 * - écriture : `^` ou `~` (tirage), puis `!` (inversion), puis `carte:` facultatif, puis le nom ;
 *   tirage et inversion selon le type de broche, pour les options dont le type est sûr ;
 * - préfixe : une carte déclarée ([mcu], [mcu nom]) ou une carte virtuelle (sonde, TMC…) ;
 * - broche utilisée deux fois, hors des partages que Klipper accepte (activation des moteurs,
 *   UART des TMC, SPI logiciel, butée d'un même axe, [duplicate_pin_override]) ;
 * - nom de broche inconnu du microcontrôleur, quand on le connaît : nom USB de la carte
 *   (`usb-Klipper_stm32f446xx_…`) ou en-tête d'une configuration d'exemple de Klipper
 *   (« This file contains common pin mappings for the BigTreeTech Octopus »).
 */

export const PIN_CODES = [
  "pin.invalid-syntax",
  "pin.modifier-not-allowed",
  "pin.unknown-chip",
  "pin.duplicate",
  "pin.shared-polarity",
  "pin.invalid-name",
  "pin.board-detected",
] as const;
export type PinCode = (typeof PIN_CODES)[number];

export interface PinIssue extends Issue<PinCode> {
  readonly severity: "error" | "warning" | "info";
  readonly file: string;
  readonly line: number;
  readonly section: string;
}

/** Microcontrôleur : famille et ports énumérés (ou nombre de GPIO pour les RP2040, RP2350). */
export type PinChip =
  | { readonly family: "stm32" | "avr" | "hc32f460"; readonly ports: string }
  | { readonly family: "lpc176x" }
  | { readonly family: "rp2040"; readonly gpio: number };

export interface PinDatabase {
  readonly commit: string;
  readonly chips: Readonly<Record<string, PinChip>>;
  readonly boards: readonly {
    readonly file: string;
    readonly line: string;
    readonly title: string;
    readonly chips: readonly string[];
  }[];
}

export const PIN_DATABASE = pinsKlipper as PinDatabase;

interface ParsedPin {
  readonly chip: string;
  readonly pin: string;
  readonly pullup: -1 | 0 | 1;
  readonly invert: 0 | 1;
}

/** Lecture comme `PrinterPins.parse_pin` (avec tirage et inversion permis) ; null si invalide. */
export function parsePin(description: string): ParsedPin | null {
  let desc = description.trim();
  let pullup: -1 | 0 | 1 = 0;
  let invert: 0 | 1 = 0;
  if (desc.startsWith("^") || desc.startsWith("~")) {
    pullup = desc.startsWith("~") ? -1 : 1;
    desc = desc.slice(1).trim();
  }
  if (desc.startsWith("!")) {
    invert = 1;
    desc = desc.slice(1).trim();
  }
  const colon = desc.indexOf(":");
  const chip = colon < 0 ? "mcu" : desc.slice(0, colon).trim();
  const pin = colon < 0 ? desc : desc.slice(colon + 1).trim();
  if (pin === "" || /[\^~!:\s]/.test(pin)) return null;
  return { chip, pin, pullup, invert };
}

/**
 * Option dont la valeur est une broche (`pin`, `…_pin`) ou une liste de broches (`…pins`). Pas
 * une broche, malgré le nom : `address_pin` (choix, ads1x1x) et `analog_range_*_pin` (plages
 * de tension, display).
 */
const isPinOption = (section: string, option: string) =>
  !section.startsWith("board_pins") &&
  section !== "duplicate_pin_override" &&
  option !== "address_pin" &&
  !option.startsWith("analog_range_") &&
  (option === "pin" || option.endsWith("_pin") || option === "pins" || option.endsWith("_pins"));

const STEPPER =
  /^(stepper_[a-z0-9]+|extruder[0-9]*|extruder_stepper .+|dual_carriage|manual_stepper .+)$/;
const HEATER = /^(extruder[0-9]*|heater_bed|heater_generic .+)$/;
const SENSOR =
  /^(extruder[0-9]*|heater_bed|heater_generic .+|temperature_sensor .+|temperature_fan .+)$/;
const FAN =
  /^(fan|heater_fan .+|controller_fan .+|fan_generic .+|temperature_fan .+|output_pin .+)$/;
const TMC = /^tmc[0-9]+ /;

interface Allowed {
  readonly pullup: boolean;
  readonly invert: boolean;
}
const NONE: Allowed = { pullup: false, invert: false };
const INVERT: Allowed = { pullup: false, invert: true };
const BOTH: Allowed = { pullup: true, invert: true };

/**
 * Tirage et inversion permis, pour les options dont le type de broche est vérifié dans Klipper
 * (stepper.py, heaters.py, adc_temperature.py, fan.py, output_pin.py, tmc_uart.py, bus.py) ;
 * undefined : seule l'écriture générale est contrôlée.
 */
function allowedModifiers(section: string, option: string): Allowed | undefined {
  if (option === "endstop_pin" && STEPPER.test(section)) return BOTH;
  if (["step_pin", "dir_pin", "enable_pin"].includes(option) && STEPPER.test(section)) {
    return INVERT;
  }
  if (option === "heater_pin" && HEATER.test(section)) return INVERT;
  if (option === "sensor_pin" && SENSOR.test(section)) return NONE;
  if ((option === "pin" || option === "enable_pin") && FAN.test(section)) return INVERT;
  if (TMC.test(section) && option === "uart_pin") return { pullup: true, invert: false };
  if (TMC.test(section) && option === "tx_pin") return NONE;
  if (option === "cs_pin" || option.startsWith("spi_software_")) return NONE;
  return undefined;
}

interface PinUse extends ParsedPin {
  readonly raw: string;
  readonly section: string;
  readonly option: string;
  readonly file: string;
  readonly line: number;
  /** Partage accepté par Klipper entre les utilisations de même clé. */
  readonly share?: string;
}

/** Clé de partage (`share_type` de Klipper, ou axe pour les butées). */
function shareOf(sections: ReadonlyMap<string, ConfigSection>, section: string, option: string) {
  if (option === "enable_pin" && STEPPER.test(section)) return "stepper_enable";
  if (option === "endstop_pin" && STEPPER.test(section)) {
    // Un même axe (stepper_z, stepper_z1…) partage sa butée ; dual_carriage est un autre axe.
    return `endstop:${section.replace(/^(stepper_[a-z])[0-9]*$/, "$1")}`;
  }
  if (TMC.test(section) && option === "uart_pin") return "tmc_uart_rx";
  if (TMC.test(section) && option === "tx_pin") return "tmc_uart_tx";
  if (option.startsWith("spi_software_") || option.startsWith("i2c_software_")) return option;
  // Multiplexeur UART des TMC (tmc_uart.py, MCU_analog_mux) : un seul par carte, commun.
  if (TMC.test(section) && option === "select_pins") return "tmc_select";
  // Boutons analogiques de l'écran (buttons.py, register_adc_button) : une entrée, plusieurs
  // boutons distingués par leur plage de tension (`analog_range_<bouton>_pin`).
  const button = option.replace(/_pin$/, "");
  if (sections.get(section)?.options.has(`analog_range_${button}_pin`)) return "adc_buttons";
  if (TMC.test(section) && option === "cs_pin") {
    const chain = Number(sections.get(section)?.options.get("chain_length")?.value ?? "1");
    if (chain > 1) return "tmc_spi_cs";
  }
  return undefined;
}

/** Carte virtuelle d'un pilote TMC : [tmc2209 stepper_x] → tmc2209_stepper_x (tmc.py). */
const tmcChip = (section: string) => {
  const parts = section.split(/\s+/);
  return `${parts[0]}_${parts.at(-1)}`;
};

const lineOf = (option: ConfigOption) => option.line;

/** Nom lisible d'un microcontrôleur : stm32g0b1xx → STM32G0B1, lpc1769 → LPC1769. */
const chipName = (id: string) => id.toUpperCase().replace(/X[A-Z0-9]$/, "");

/** Élément d'un tableau dont l'indice est connu valide. */
const at = <T>(items: ArrayLike<T>, index: number) => items[index] as T;

/** Distance d'édition, sans tenir compte des majuscules (suggestion de carte). */
function distance(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  const row = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    let previous = at(row, 0);
    row[0] = i;
    for (let j = 1; j <= y.length; j++) {
      const current = at(row, j);
      row[j] = Math.min(
        current + 1,
        at(row, j - 1) + 1,
        previous + (x[i - 1] === y[j - 1] ? 0 : 1),
      );
      previous = current;
    }
  }
  return at(row, y.length);
}

/** Port et numéro d'une broche « PA1 » dans les limites données ; null sinon. */
function portPin(pin: string, ports: string, last: number): boolean {
  const match = /^P([A-L])([0-9]+)$/.exec(pin);
  return !!match && ports.includes(at(match, 1)) && Number(at(match, 2)) <= last;
}

/** Noms que le micrologiciel énumère (src/<arch>/gpio.c, adc.c). */
function validName(chip: PinChip, pin: string): boolean {
  switch (chip.family) {
    case "lpc176x":
      return /^P[0-4]\.([0-9]|[12][0-9]|3[01])$/.test(pin);
    case "rp2040": {
      const match = /^gpio([0-9]+)$/.exec(pin);
      return pin === "ADC_TEMPERATURE" || (!!match && Number(at(match, 1)) < chip.gpio);
    }
    case "avr":
      return portPin(pin, chip.ports, 7);
    case "hc32f460":
      return pin === "PH2" || portPin(pin, chip.ports, 15);
    default:
      return pin === "ADC_TEMPERATURE" || portPin(pin, chip.ports, 15);
  }
}

/** Plage lisible des noms : « PA0 – PH15 », « P0.0 – P4.31 », « gpio0 – gpio29 ». */
function nameRange(chip: PinChip): string {
  switch (chip.family) {
    case "lpc176x":
      return "P0.0 – P4.31";
    case "rp2040":
      return `gpio0 – gpio${chip.gpio - 1}`;
    default:
      return `PA0 – P${chip.ports.slice(-1)}${chip.family === "avr" ? 7 : 15}`;
  }
}

interface McuChips {
  readonly chips: readonly string[];
  /** Carte reconnue par l'en-tête d'une configuration d'exemple. */
  readonly header?: { readonly board: string; readonly file: string; readonly line: number };
}

/** Microcontrôleur de chaque carte : nom USB, sinon en-tête d'une configuration d'exemple. */
function chipsOfMcus(
  sections: readonly ConfigSection[],
  files: ReadonlyMap<string, string>,
  db: PinDatabase,
): Map<string, McuChips> {
  const result = new Map<string, McuChips>();
  const mcus = sections.filter((s) => s.name === "mcu" || s.name.startsWith("mcu "));
  for (const section of mcus) {
    const name = section.name === "mcu" ? "mcu" : section.name.slice(4).trim();
    const serial = section.options.get("serial")?.value ?? "";
    const usb = /usb-Klipper_([a-z0-9]+)_/.exec(serial)?.[1];
    if (usb && db.chips[usb]) result.set(name, { chips: [usb] });
  }
  const normalize = (line: string) => line.trim().replace(/\s+/g, " ").toLowerCase();
  const byLine = new Map<string, (typeof db.boards)[number][]>();
  for (const board of db.boards) {
    const key = normalize(board.line);
    byLine.set(key, [...(byLine.get(key) ?? []), board]);
  }
  for (const [file, text] of files) {
    const lines = text.split("\n").slice(0, 40).map(normalize);
    const index = lines.findIndex((line) => byLine.has(line));
    const boards = index < 0 ? [] : (byLine.get(at(lines, index)) as (typeof db.boards)[number][]);
    const chips = [...new Set(boards.flatMap((b) => b.chips))].filter((c) => db.chips[c]);
    if (chips.length === 0) continue;
    // La carte de ce fichier : sa seule section [mcu…], sinon [mcu] pour le fichier principal.
    const own = mcus.filter((s) => s.file === file);
    const target =
      own.length === 1 ? own[0] : own.length === 0 ? mcus.find((s) => s.name === "mcu") : undefined;
    if (!target) continue;
    const name = target.name === "mcu" ? "mcu" : target.name.slice(4).trim();
    if (result.has(name)) continue;
    result.set(name, { chips, header: { board: at(boards, 0).title, file, line: index + 1 } });
  }
  return result;
}

export interface PinCheckOptions {
  /** Texte brut de chaque fichier lu : en-têtes des configurations d'exemple. */
  readonly files?: ReadonlyMap<string, string>;
  /**
   * Configuration incomplète (fichier inclus absent) : une carte peut y être déclarée, aucun
   * préfixe n'est alors dit inconnu.
   */
  readonly partial?: boolean;
  readonly database?: PinDatabase;
}

export function checkPins(
  sections: readonly ConfigSection[],
  options: PinCheckOptions = {},
): PinIssue[] {
  const db = options.database ?? PIN_DATABASE;
  const issues: PinIssue[] = [];
  const byName = new Map(sections.map((s) => [s.name, s]));
  const issue = (
    code: PinCode,
    severity: PinIssue["severity"],
    where: { file: string; line: number; section: string },
    params: Record<string, string | number>,
  ) => issues.push({ code, severity, ...where, params });

  // Cartes déclarées et cartes virtuelles enregistrées par les modules (register_chip).
  const chips = new Set<string>();
  const virtual = new Map<string, string>();
  // [mcu] est toujours déclarée dans une configuration complète ; un extrait sans elle (fichier
  // d'exemple, fichier inclus vérifié seul) n'est pas une faute de préfixe.
  chips.add("mcu");
  for (const { name } of sections) {
    if (name === "mcu") chips.add("mcu");
    else if (name.startsWith("mcu ")) chips.add(name.slice(4).trim());
    else if (TMC.test(name)) virtual.set(tmcChip(name), "virtual_endstop");
    else if (name.startsWith("multi_pin ")) virtual.set("multi_pin", "");
    else if (name.startsWith("sx1509 ")) virtual.set(`sx1509_${name.slice(7).trim()}`, "");
    else if (name.startsWith("adc_scaled ")) virtual.set(name.split(/\s+/)[1] ?? "", "");
    else if (/^ads1[0-9]{3} /.test(name)) virtual.set(name.split(/\s+/).at(-1) ?? "", "");
    else if (name === "replicape") virtual.set("replicape", "");
  }
  // Sonde : sa carte virtuelle existe dès qu'un module de sonde est chargé ; sans en connaître
  // la liste complète, le préfixe « probe » est toujours accepté.
  virtual.set("probe", "z_virtual_endstop");

  // Alias des cartes ([board_pins]) : nom → broche, par carte.
  const aliases = new Map<string, Map<string, string>>();
  for (const section of sections) {
    if (!section.name.startsWith("board_pins")) continue;
    const targets = (section.options.get("mcu")?.value ?? "mcu").split(",").map((s) => s.trim());
    for (const [name, option] of section.options) {
      if (name !== "aliases" && !name.startsWith("aliases_")) continue;
      for (const entry of option.value.split(/[,\n]/)) {
        const [alias, value] = entry.split("=").map((s) => s.trim());
        if (!alias || !value || value.startsWith("<")) continue;
        for (const target of targets) {
          const map = aliases.get(target) ?? new Map<string, string>();
          map.set(alias, value);
          aliases.set(target, map);
        }
      }
    }
  }
  const overridden = new Set<string>();
  for (const value of byName.get("duplicate_pin_override")?.options.get("pins")?.value.split(",") ??
    []) {
    const parsed = parsePin(value);
    if (parsed) overridden.add(`${parsed.chip}:${parsed.pin}`);
  }

  const mcuChips = chipsOfMcus(sections, options.files ?? new Map(), db);
  for (const [mcu, info] of mcuChips) {
    if (!info.header) continue;
    const { board, file, line } = info.header;
    issue(
      "pin.board-detected",
      "info",
      { file, line, section: mcu === "mcu" ? "mcu" : `mcu ${mcu}` },
      { mcu, board, chip: info.chips.map(chipName).join(", ") },
    );
  }

  // Butées virtuelles des TMC réellement utilisées (endstop_pin: tmc2209_stepper_x:virtual_endstop).
  const virtualEndstops = new Set<string>();
  for (const section of sections) {
    const value = section.options.get("endstop_pin")?.value;
    const parsed = value ? parsePin(value) : null;
    if (parsed && parsed.pin === "virtual_endstop") virtualEndstops.add(parsed.chip);
  }

  const uses: PinUse[] = [];
  for (const section of sections) {
    for (const [name, option] of section.options) {
      if (!isPinOption(section.name, name)) continue;
      if (option.value.includes("{")) continue; // Interpolation (Kalico) : valeur inconnue ici.
      const values =
        name === "pins" || name.endsWith("_pins") ? option.value.split(",") : [option.value];
      const where = { file: option.file, line: lineOf(option), section: section.name };
      for (const raw of values.map((v) => v.trim()).filter(Boolean)) {
        const parsed = parsePin(raw);
        if (!parsed) {
          issue("pin.invalid-syntax", "error", where, { option: name, value: raw });
          continue;
        }
        const allowed = allowedModifiers(section.name, name);
        const virtualPin = virtual.has(parsed.chip) && !chips.has(parsed.chip);
        if (parsed.pullup !== 0 && (allowed?.pullup === false || virtualPin)) {
          issue("pin.modifier-not-allowed", "error", where, {
            option: name,
            value: raw,
            modifier: "pullup",
          });
        } else if (parsed.invert && (allowed?.invert === false || virtualPin)) {
          issue("pin.modifier-not-allowed", "error", where, {
            option: name,
            value: raw,
            modifier: "invert",
          });
        }
        if (!chips.has(parsed.chip) && !virtual.has(parsed.chip)) {
          if (options.partial) continue;
          // [mcu] est toujours connue : la liste n'est jamais vide.
          const [best, cost] = at(
            [...chips, ...virtual.keys()]
              .map((c) => [c, distance(parsed.chip, c)] as const)
              .sort((a, b) => a[1] - b[1]),
            0,
          );
          issue("pin.unknown-chip", "error", where, {
            chip: parsed.chip,
            suggestion: cost <= 2 ? best : "none",
          });
          continue;
        }
        const pin = aliases.get(parsed.chip)?.get(parsed.pin) ?? parsed.pin;
        const share = shareOf(byName, section.name, name);
        // Broche de diagnostic d'un TMC : lue par Klipper seulement si une butée virtuelle
        // l'utilise (tmc.py, TMCVirtualPinHelper) ; sinon, aucun conflit possible.
        const diag = TMC.test(section.name) && /^diag[01]?_pin$/.test(name);
        if (diag && !virtualEndstops.has(tmcChip(section.name))) continue;
        uses.push({
          ...parsed,
          pin,
          raw,
          section: section.name,
          option: name,
          file: option.file,
          line: lineOf(option),
          ...(share ? { share } : {}),
        });
        // Nom de broche : carte virtuelle (nom imposé) ou microcontrôleur connu.
        const expected = virtual.get(parsed.chip);
        if (virtualPin && expected && pin !== expected) {
          issue("pin.invalid-name", "error", where, {
            pin,
            mcu: parsed.chip,
            chip: "none",
            range: expected,
            suggestion: "none",
          });
          continue;
        }
        const info = mcuChips.get(parsed.chip);
        if (!info) continue;
        // Microcontrôleurs retenus : tous présents dans la base (filtrés par chipsOfMcus).
        const candidates = info.chips.map((c) => db.chips[c] as PinChip);
        if (!candidates.some((c) => validName(c, pin))) {
          const upper = pin.toUpperCase();
          issue("pin.invalid-name", "error", where, {
            pin,
            mcu: parsed.chip,
            chip: info.chips.map(chipName).join(", "),
            range: nameRange(at(candidates, 0)),
            suggestion: candidates.some((c) => validName(c, upper)) ? upper : "none",
          });
        }
      }
    }
  }

  // Broches utilisées plusieurs fois (première utilisation = référence).
  const first = new Map<string, PinUse>();
  for (const use of uses) {
    const key = `${use.chip}:${use.pin}`;
    const previous = first.get(key);
    if (!previous) {
      first.set(key, use);
      continue;
    }
    if (overridden.has(key) || overridden.has(`${use.chip}:${use.raw}`)) continue;
    const where = { file: use.file, line: use.line, section: use.section };
    const other = {
      pin: use.chip === "mcu" ? use.pin : `${use.chip}:${use.pin}`,
      otherSection: previous.section,
      otherOption: previous.option,
      otherLine: previous.line,
    };
    if (use.share && use.share === previous.share) {
      // Multiplexeur : chaque pilote est désigné par sa propre combinaison de polarités.
      if (use.share === "tmc_select") continue;
      if (use.pullup !== previous.pullup || use.invert !== previous.invert) {
        issue("pin.shared-polarity", "error", where, other);
      }
      continue;
    }
    issue("pin.duplicate", "error", where, other);
  }
  return issues;
}
