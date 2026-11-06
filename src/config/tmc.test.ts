// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from "vitest";
import { parseConfig } from "./ini";
import { checkTmc } from "./tmc";

const check = (text: string) => checkTmc(parseConfig(text));
const codes = (text: string) => check(text).map((issue) => issue.code);

describe("courant des pilotes TMC (EP-06.06, formules de klippy/extras/tmc*.py)", () => {
  it("TMC2209 : plafonné au maximum que permet sense_resistor", () => {
    // 0,32 / ((0,150 + 0,020) × √2) = 1,331 A.
    expect(check("[tmc2209 stepper_x]\nrun_current: 1.5\nsense_resistor: 0.150\n")).toEqual([
      expect.objectContaining({
        code: "tmc.current-capped",
        severity: "warning",
        line: 2,
        section: "tmc2209 stepper_x",
        params: { driver: "tmc2209", requested: 1.5, max: 1.331, resistor: 0.15, declared: "yes" },
      }),
    ]);
    // Résistance par défaut de Klipper (0,110 Ω) : 1,741 A au plus.
    expect(check("[tmc2209 stepper_y]\nrun_current: 1.9\n")[0]?.params).toEqual({
      driver: "tmc2209",
      requested: 1.9,
      max: 1.741,
      resistor: 0.11,
      declared: "no",
    });
    expect(codes("[tmc2209 stepper_y]\nrun_current: 1.2\n")).toEqual([]);
    // Écart d'arrondi (moins de 0,01 A) : rien.
    expect(codes("[tmc2209 stepper_y]\nrun_current: 1.745\n")).toEqual([]);
  });

  it("TMC5160 et TMC2660 : leurs propres formules", () => {
    // 0,325 / (0,075 × √2) = 3,064 A.
    expect(check("[tmc5160 stepper_x]\nrun_current: 3.5\n")[0]?.params).toMatchObject({
      driver: "tmc5160",
      max: 3.064,
    });
    expect(codes("[tmc5160 stepper_x]\nrun_current: 2.5\n")).toEqual([]);
    // 0,310 / (0,15 × √2) = 1,461 A ; sans sense_resistor (obligatoire) : déjà signalé ailleurs.
    expect(
      check("[tmc2660 stepper_x]\nrun_current: 2\nsense_resistor: 0.15\n")[0]?.params,
    ).toMatchObject({
      max: 1.461,
    });
    expect(codes("[tmc2660 stepper_x]\nrun_current: 2\nsense_resistor: 0.1\n")).toEqual([]);
    expect(codes("[tmc2660 stepper_x]\nrun_current: 2\n")).toEqual([]);
  });

  it("TMC2240 : au-delà de 36000 / rref / √2, Klipper refuse de démarrer", () => {
    expect(check("[tmc2240 stepper_x]\nrun_current: 2.5\n")).toEqual([
      expect.objectContaining({
        code: "tmc.current-above-max",
        severity: "error",
        params: {
          driver: "tmc2240",
          option: "run_current",
          requested: 2.5,
          max: 2.121,
          rref: 12000,
        },
      }),
    ]);
    const rref = check("[tmc2240 stepper_x]\nrun_current: 1.2\nhold_current: 1.1\nrref: 24000\n");
    expect(rref.map((i) => [i.params?.["option"], i.params?.["max"]])).toEqual([
      ["run_current", 1.061],
      ["hold_current", 1.061],
    ]);
    expect(codes("[tmc2240 stepper_x]\nrun_current: 2\n")).toEqual([]);
  });
});

describe("homing sans capteur (EP-06.06, TMC_Drivers.md et tmc.py)", () => {
  const stepper = (extra = "") =>
    `[stepper_x]\nendstop_pin: tmc2209_stepper_x:virtual_endstop\n${extra}`;

  it("configuration complète : rien à signaler", () => {
    expect(
      codes(
        `${stepper("homing_retract_dist: 0\n")}[tmc2209 stepper_x]\nrun_current: 0.8\ndiag_pin: ^PA1\ndriver_SGTHRS: 120\n`,
      ),
    ).toEqual([]);
  });

  it("broche DIAG absente, retrait par défaut, hold_current, SGTHRS par défaut", () => {
    const issues = check(`${stepper()}[tmc2209 stepper_x]\nrun_current: 0.8\nhold_current: 0.5\n`);
    expect(issues.map((i) => [i.code, i.severity])).toEqual([
      ["tmc.diag-pin-missing", "error"],
      ["tmc.sensorless-retract", "warning"],
      ["tmc.sensorless-hold-current", "info"],
      ["tmc.sgthrs-default", "warning"],
    ]);
    expect(issues[0]?.params).toEqual({
      driver: "tmc2209",
      options: "diag_pin",
      stepper: "stepper_x",
    });
    expect(issues[1]).toMatchObject({ line: 2, params: { distance: 5, declared: "no" } });
  });

  it("retrait déclaré non nul : signalé à sa ligne", () => {
    const issues = check(
      `${stepper("homing_retract_dist: 3\n")}[tmc2209 stepper_x]\nrun_current: 0.8\ndiag_pin: PA1\ndriver_SGTHRS: 100\n`,
    );
    expect(issues).toEqual([
      expect.objectContaining({
        code: "tmc.sensorless-retract",
        line: 3,
        params: { distance: 3, declared: "yes" },
      }),
    ]);
  });

  it("TMC2130, TMC5160 : diag0_pin ou diag1_pin ; diag_pin ne compte pas", () => {
    const tmc2130 = (diag: string) =>
      `[stepper_y]\nendstop_pin: tmc2130_stepper_y:virtual_endstop\nhoming_retract_dist: 0\n[tmc2130 stepper_y]\nrun_current: 0.8\n${diag}`;
    expect(codes(tmc2130("diag1_pin: ^!PA1\n"))).toEqual([]);
    expect(codes(tmc2130("diag0_pin: PA1\n"))).toEqual([]);
    expect(check(tmc2130("diag_pin: PA1\n"))[0]).toMatchObject({
      code: "tmc.diag-pin-missing",
      params: { options: "diag0_pin / diag1_pin" },
    });
  });

  it("TMC2208 ou TMC2660 : pas de butée virtuelle dans Klipper", () => {
    expect(
      check(
        "[stepper_x]\nendstop_pin: tmc2208_stepper_x:virtual_endstop\n[tmc2208 stepper_x]\nrun_current: 0.8\n",
      ),
    ).toEqual([
      expect.objectContaining({
        code: "tmc.virtual-endstop-unsupported",
        severity: "error",
        section: "stepper_x",
        params: { driver: "tmc2208", chip: "tmc2208_stepper_x" },
      }),
    ]);
  });

  it("carte nommée comme Klipper : premier et dernier mot de la section", () => {
    const text =
      "[stepper_z1]\nendstop_pin: tmc5160_stepper_z1:virtual_endstop\nhoming_retract_dist: 0\n[tmc5160 stepper_z1]\nrun_current: 1\n";
    expect(codes(text)).toEqual(["tmc.diag-pin-missing"]);
    // Butée physique : aucun contrôle de homing sans capteur.
    expect(
      codes("[stepper_x]\nendstop_pin: ^PA1\n[tmc2209 stepper_x]\nrun_current: 0.8\n"),
    ).toEqual([]);
    // Pilote absent : carte inconnue, signalée par le contrôle des broches.
    expect(codes("[stepper_x]\nendstop_pin: tmc2209_stepper_x:virtual_endstop\n")).toEqual([]);
  });
});
