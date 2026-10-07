// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from "vitest";
import { parseConfig, readConfig } from "./ini";
import { checkPins, PIN_DATABASE, parsePin } from "./pins";

const check = (text: string) =>
  checkPins(parseConfig(text)).map((i) => ({
    code: i.code,
    section: i.section,
    ...i.params,
  }));

describe("lecture d'une broche, comme PrinterPins.parse_pin", () => {
  it.each([
    ["PA1", { chip: "mcu", pin: "PA1", pullup: 0, invert: 0 }],
    ["^!PA1", { chip: "mcu", pin: "PA1", pullup: 1, invert: 1 }],
    ["~ ! EBBCan:PB13", { chip: "EBBCan", pin: "PB13", pullup: -1, invert: 1 }],
    ["probe:z_virtual_endstop", { chip: "probe", pin: "z_virtual_endstop", pullup: 0, invert: 0 }],
  ])("%s", (text, expected) => {
    expect(parsePin(text)).toEqual(expected);
  });

  it.each(["!^PA1", "mcu:!PA1", "PA 1", "", "^^PA1", "EBBCan:"])("refusée : « %s »", (text) => {
    expect(parsePin(text)).toBeNull();
  });
});

describe("contrôle des broches (EP-06.04)", () => {
  it("écriture, tirage et inversion selon le type de broche", () => {
    expect(
      check(
        [
          "[mcu]",
          "serial: /dev/ttyACM0",
          "[stepper_x]",
          "step_pin: ^PA1",
          "dir_pin: !PA2",
          "endstop_pin: ^!PA3",
          "[extruder]",
          "heater_pin: !PA4",
          "sensor_pin: !PA5",
          "[fan]",
          "pin: PA6 !",
          "[tmc2209 stepper_x]",
          "uart_pin: ^PA7",
          "tx_pin: !PA8",
          "[output_pin led]",
          "pin: ~PA9",
        ].join("\n"),
      ),
    ).toEqual([
      {
        code: "pin.modifier-not-allowed",
        section: "stepper_x",
        option: "step_pin",
        value: "^PA1",
        modifier: "pullup",
      },
      {
        code: "pin.modifier-not-allowed",
        section: "extruder",
        option: "sensor_pin",
        value: "!PA5",
        modifier: "invert",
      },
      { code: "pin.invalid-syntax", section: "fan", option: "pin", value: "PA6 !" },
      {
        code: "pin.modifier-not-allowed",
        section: "tmc2209 stepper_x",
        option: "tx_pin",
        value: "!PA8",
        modifier: "invert",
      },
      {
        code: "pin.modifier-not-allowed",
        section: "output_pin led",
        option: "pin",
        value: "~PA9",
        modifier: "pullup",
      },
    ]);
  });

  it("préfixe : cartes déclarées et virtuelles ; inconnue avec suggestion", () => {
    expect(
      check(
        [
          "[mcu]",
          "[mcu EBBCan]",
          "[tmc2209 stepper_x]",
          "uart_pin: PC11",
          "diag_pin: ^PG6",
          "[stepper_x]",
          "endstop_pin: tmc2209_stepper_x:virtual_endstop",
          "[stepper_z]",
          "endstop_pin: probe:z_virtual_endstop",
          "[extruder]",
          "heater_pin: EBBcan:PB13",
          "sensor_pin: toolboard:PA3",
          "[multi_pin fans]",
          "pins: PA1, PA2",
          "[fan]",
          "pin: multi_pin:fans",
        ].join("\n"),
      ),
    ).toEqual([
      { code: "pin.unknown-chip", section: "extruder", chip: "EBBcan", suggestion: "EBBCan" },
      { code: "pin.unknown-chip", section: "extruder", chip: "toolboard", suggestion: "none" },
    ]);
  });

  it("broches virtuelles : nom imposé, ni tirage ni inversion", () => {
    expect(
      check(
        [
          "[mcu]",
          "[tmc2209 stepper_y]",
          "uart_pin: PC10",
          "[stepper_y]",
          "endstop_pin: ^tmc2209_stepper_y:virtual_endstop",
          "[stepper_z]",
          "endstop_pin: probe:z_endstop",
        ].join("\n"),
      ),
    ).toEqual([
      {
        code: "pin.modifier-not-allowed",
        section: "stepper_y",
        option: "endstop_pin",
        value: "^tmc2209_stepper_y:virtual_endstop",
        modifier: "pullup",
      },
      {
        code: "pin.invalid-name",
        section: "stepper_z",
        pin: "z_endstop",
        mcu: "probe",
        chip: "none",
        range: "z_virtual_endstop",
        suggestion: "none",
      },
    ]);
  });

  it("broche utilisée deux fois ; partages acceptés par Klipper ; polarité des partages", () => {
    expect(
      check(
        [
          "[mcu]",
          "[stepper_z]",
          "enable_pin: !PA1",
          "endstop_pin: ^PB1",
          "[stepper_z1]",
          "enable_pin: !PA1",
          "endstop_pin: ^PB1",
          "[stepper_z2]",
          "enable_pin: PA1",
          "endstop_pin: PB1",
          "[stepper_x]",
          "endstop_pin: PB1",
          "[tmc2209 stepper_z]",
          "uart_pin: PC1",
          "[tmc2209 stepper_z1]",
          "uart_pin: PC1",
          "[fan]",
          "pin: PD1",
          "[heater_fan hotend]",
          "pin: PD1",
          "[output_pin a]",
          "pin: PE1",
          "[output_pin b]",
          "pin: PE1",
          "[duplicate_pin_override]",
          "pins: PE1",
        ].join("\n"),
      ),
    ).toEqual([
      {
        code: "pin.shared-polarity",
        section: "stepper_z2",
        pin: "PA1",
        otherSection: "stepper_z",
        otherOption: "enable_pin",
        otherLine: 3,
      },
      {
        code: "pin.shared-polarity",
        section: "stepper_z2",
        pin: "PB1",
        otherSection: "stepper_z",
        otherOption: "endstop_pin",
        otherLine: 4,
      },
      {
        code: "pin.duplicate",
        section: "stepper_x",
        pin: "PB1",
        otherSection: "stepper_z",
        otherOption: "endstop_pin",
        otherLine: 4,
      },
      {
        code: "pin.duplicate",
        section: "heater_fan hotend",
        pin: "PD1",
        otherSection: "fan",
        otherOption: "pin",
        otherLine: 18,
      },
    ]);
  });

  it("alias de la carte ([board_pins]) : même broche sous deux noms", () => {
    expect(
      check(
        [
          "[mcu]",
          "[board_pins]",
          "aliases: EXP1_1=PE9, EXP1_2=<GND>",
          "[fan]",
          "pin: EXP1_1",
          "[output_pin x]",
          "pin: PE9",
        ].join("\n"),
      ),
    ).toEqual([
      {
        code: "pin.duplicate",
        section: "output_pin x",
        pin: "PE9",
        otherSection: "fan",
        otherOption: "pin",
        otherLine: 5,
      },
    ]);
  });

  it("nom inconnu du microcontrôleur : nom USB de la carte", () => {
    expect(
      check(
        [
          "[mcu]",
          "serial: /dev/serial/by-id/usb-Klipper_stm32g0b1xx_4000150012504B4633373520-if00",
          "[stepper_x]",
          "step_pin: PG1",
          "dir_pin: pb4",
          "enable_pin: !PC11",
          "[extruder]",
          "sensor_pin: ADC_TEMPERATURE",
          "heater_pin: P2.7",
        ].join("\n"),
      ),
    ).toEqual([
      {
        code: "pin.invalid-name",
        section: "stepper_x",
        pin: "PG1",
        mcu: "mcu",
        chip: "STM32G0B1",
        range: "PA0 – PF15",
        suggestion: "none",
      },
      {
        code: "pin.invalid-name",
        section: "stepper_x",
        pin: "pb4",
        mcu: "mcu",
        chip: "STM32G0B1",
        range: "PA0 – PF15",
        suggestion: "PB4",
      },
      {
        code: "pin.invalid-name",
        section: "extruder",
        pin: "P2.7",
        mcu: "mcu",
        chip: "STM32G0B1",
        range: "PA0 – PF15",
        suggestion: "none",
      },
    ]);
  });

  it("carte reconnue par l'en-tête d'une configuration d'exemple (fichier inclus, carte de tête)", () => {
    const main = [
      "# This file contains common pin mappings for the BIGTREETECH SKR V1.4",
      "# board. To use this config, the firmware should be compiled for the",
      "[include ebb.cfg]",
      "[mcu]",
      "serial: /dev/ttyAMA0",
      "[stepper_x]",
      "step_pin: P2.2",
      "dir_pin: PB4",
    ].join("\n");
    const ebb = [
      "# This file contains common pin mappings for the BIGTREETECH EBBCan",
      "# Canbus board. To use this config, the firmware should be compiled for the",
      '# STM32G0B1 with "8 MHz crystal" and "USB (on PA11/PA12)" or "CAN bus (on PB0/PB1)".',
      "[mcu EBBCan]",
      "canbus_uuid: 642f53509351",
      "[extruder]",
      "step_pin: EBBCan:PD0",
      "dir_pin: EBBCan:P1.2",
    ].join("\n");
    const files = new Map([
      ["printer.cfg", main],
      ["ebb.cfg", ebb],
    ]);
    const { sections } = readConfig({ files, main: "printer.cfg" });
    const issues = checkPins(sections, { files }).map((i) => ({ code: i.code, ...i.params }));
    // L'en-tête de l'EBB est commun aux versions 1.0 (STM32F072) et 1.1, 1.2 (STM32G0B1).
    expect(issues).toEqual([
      {
        code: "pin.board-detected",
        mcu: "mcu",
        board: "BIGTREETECH SKR V1.4",
        chip: "LPC1768, LPC1769",
      },
      {
        code: "pin.board-detected",
        mcu: "EBBCan",
        board: "BIGTREETECH EBBCan Canbus",
        chip: "STM32F072, STM32G0B1",
      },
      {
        code: "pin.invalid-name",
        pin: "P1.2",
        mcu: "EBBCan",
        chip: "STM32F072, STM32G0B1",
        range: "PA0 – PF15",
        suggestion: "none",
      },
      {
        code: "pin.invalid-name",
        pin: "PB4",
        mcu: "mcu",
        chip: "LPC1768, LPC1769",
        range: "P0.0 – P4.31",
        suggestion: "none",
      },
    ]);
  });

  it("base des broches : microcontrôleurs et cartes courantes présents", () => {
    expect(PIN_DATABASE.chips["stm32f446xx"]).toEqual({ family: "stm32", ports: "ABCDEFGH" });
    expect(PIN_DATABASE.chips["rp2040"]).toEqual({ family: "rp2040", gpio: 30 });
    const chipsOf = (file: string) => PIN_DATABASE.boards.find((b) => b.file === file)?.chips;
    expect(chipsOf("generic-bigtreetech-octopus-v1.1.cfg")).toEqual(["stm32f446xx", "stm32f429xx"]);
    expect(chipsOf("generic-creality-v4.2.7.cfg")).toEqual(["stm32f103xe"]);
    expect(chipsOf("generic-bigtreetech-manta-m8p-v1.1.cfg")).toEqual(["stm32g0b1xx"]);
    expect(chipsOf("generic-bigtreetech-skr-v1.4.cfg")).toEqual(["lpc1768", "lpc1769"]);
  });
});

describe("contrôle des broches : familles de microcontrôleurs et partages particuliers", () => {
  const codes = (text: string, options: { partial?: boolean } = {}) =>
    checkPins(parseConfig(text), { files: new Map([["printer.cfg", text]]), ...options }).map((i) =>
      `${i.code} ${i.params?.["pin"] ?? i.params?.["chip"] ?? ""}`.trim(),
    );

  it("LPC176x et RP2040 (nom USB), AVR et HC32 (en-tête d'exemple)", () => {
    expect(
      codes(
        [
          "[mcu]",
          "serial: /dev/serial/by-id/usb-Klipper_lpc1769_12345-if00",
          "[stepper_x]",
          "step_pin: P2.2",
          "dir_pin: P5.1",
        ].join("\n"),
      ),
    ).toEqual(["pin.invalid-name P5.1"]);
    expect(
      codes(
        [
          "[mcu]",
          "serial: /dev/serial/by-id/usb-Klipper_rp2040_E66138935F4B2E2B-if00",
          "[stepper_x]",
          "step_pin: gpio29",
          "dir_pin: gpio30",
          "[temperature_sensor mcu]",
          "sensor_pin: ADC_TEMPERATURE",
        ].join("\n"),
      ),
    ).toEqual(["pin.invalid-name gpio30"]);
    expect(
      codes(
        [
          "# This file contains common pin mappings for Einsy Rambo boards. To use",
          "[mcu]",
          "serial: /dev/ttyACM0",
          "[stepper_x]",
          "step_pin: PC0",
          "dir_pin: PI1",
          "enable_pin: PL8",
        ].join("\n"),
      ),
    ).toEqual(["pin.board-detected ATMEGA2560", "pin.invalid-name PI1", "pin.invalid-name PL8"]);
    expect(
      codes(
        [
          "# This file contains pin mappings for the Creality Ender2 Pro",
          "[mcu]",
          "[extruder]",
          "heater_pin: PH2",
          "sensor_pin: PH3",
        ].join("\n"),
      ),
    ).toEqual(["pin.board-detected HC32F460", "pin.invalid-name PH3"]);
  });

  it("cartes virtuelles des modules, inversion interdite sur cs_pin et SPI logiciel", () => {
    expect(
      codes(
        [
          "[mcu]",
          "[sx1509 expander]",
          "[adc_scaled mon_adc]",
          "vref_pin: PA1",
          "vssa_pin: PA2",
          "[ads1115 adc_ext]",
          "[replicape]",
          "[output_pin a]",
          "pin: sx1509_expander:PIN_1",
          "[output_pin b]",
          "pin: replicape:power_e",
          "[temperature_sensor x]",
          "sensor_pin: mon_adc:PB1",
          "[temperature_sensor y]",
          "sensor_pin: adc_ext:AIN0",
          "[adxl345]",
          "cs_pin: !PA4",
          "spi_software_sclk_pin: ^PA5",
        ].join("\n"),
      ),
    ).toEqual(["pin.modifier-not-allowed", "pin.modifier-not-allowed"]);
  });

  it("partages : multiplexeur TMC, chaîne SPI, I2C logiciel, boutons analogiques, alias préfixés", () => {
    expect(
      codes(
        [
          "[mcu]",
          "[tmc2208 stepper_x]",
          "select_pins: !PC14, !PC16",
          "[tmc2208 stepper_y]",
          "select_pins: PC14, !PC16",
          "[tmc5160 stepper_z]",
          "cs_pin: PA1",
          "chain_position: 1",
          "chain_length: 2",
          "[tmc5160 stepper_z1]",
          "cs_pin: PA1",
          "chain_position: 2",
          "chain_length: 2",
          "[mcp4018 x_pot]",
          "i2c_software_scl_pin: PJ5",
          "[mcp4018 y_pot]",
          "i2c_software_scl_pin: PJ5",
          "[display]",
          "up_pin: PA0",
          "analog_range_up_pin: 0, 100",
          "down_pin: PA0",
          "analog_range_down_pin: 200, 300",
          "[board_pins]",
          "mcu: mcu",
          "aliases_exp: EXP2_1=PB3",
          "[fan]",
          "pin: EXP2_1",
          "[output_pin x]",
          "pin: PB3",
        ].join("\n"),
      ),
    ).toEqual(["pin.duplicate PB3"]);
  });

  it("broche de diagnostic TMC : conflit seulement si sa butée virtuelle sert ; extraits et Kalico", () => {
    const tmc = (endstop: string) =>
      codes(
        [
          "[mcu]",
          "[tmc2209 stepper_y]",
          "uart_pin: PC1",
          "diag_pin: ^PC3",
          "[tmc2209 stepper_z]",
          "uart_pin: PC2",
          "diag_pin: PC3",
          "[stepper_y]",
          "endstop_pin: tmc2209_stepper_y:virtual_endstop",
          "[stepper_z]",
          `endstop_pin: ${endstop}`,
        ].join("\n"),
      );
    expect(tmc("probe:z_virtual_endstop")).toEqual([]);
    expect(tmc("tmc2209_stepper_z:virtual_endstop")).toEqual(["pin.duplicate PC3"]);
    const fragment = ["[extruder]", "heater_pin: MKS_THR:PB1", "sensor_pin: {constants.pin}"].join(
      "\n",
    );
    expect(codes(fragment, { partial: true })).toEqual([]);
    expect(codes(fragment)).toEqual(["pin.unknown-chip MKS_THR"]);
  });

  it("en-tête d'exemple sans carte unique dans le fichier : pas de rattachement", () => {
    const text = [
      "# This file contains common pin mappings for the BIGTREETECH SKR V1.4",
      "[mcu one]",
      "[mcu two]",
      "[output_pin x]",
      "pin: one:PZ9",
    ].join("\n");
    expect(codes(text)).toEqual([]);
  });
});
