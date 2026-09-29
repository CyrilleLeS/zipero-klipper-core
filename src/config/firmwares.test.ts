// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from "vitest";
import { detectFirmware, FIRMWARES, loadSchema } from "./firmwares";
import { parseConfig } from "./ini";

describe("firmwares (EP-01.17)", () => {
  it.each(FIRMWARES)("%s : schéma chargé, généré depuis son propre code", async (firmware) => {
    const schema = await loadSchema(firmware);
    expect(schema.firmware).toBe(firmware);
    expect(schema.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(schema.rules.length).toBeGreaterThan(150);
  });

  it.each([
    [
      "Creality K1",
      "[prtouch_v2]\npr_version: 1\n[printer]\nkinematics: corexy",
      "creality-k1",
      "[prtouch_v2]",
    ],
    [
      "Qidi Plus 4",
      "[stepper_z]\nendstop_pin_reverse: tmc2209_stepper_z:virtual_endstop\n[qdprobe]\npin: PA1",
      "qidi-plus4",
      "[qdprobe]",
    ],
    ["Kalico", "[danger_options]\nlog_statistics: False", "kalico", "[danger_options]"],
  ])("détecte %s", (_label, text, firmware, evidence) => {
    const detection = detectFirmware(parseConfig(text));
    expect(detection.firmware).toBe(firmware);
    expect(detection.candidates[0]?.evidence).toContain(evidence);
  });

  it("aucun indice (ni module installé à part) : Klipper", () => {
    const text =
      "[printer]\nkinematics: cartesian\n[gcode_shell_command sauvegarde]\ncommand: echo\n[z_calibration]\nswitch_offset: 0.5";
    expect(detectFirmware(parseConfig(text))).toEqual({
      firmware: "klipper",
      ambiguous: false,
      candidates: [],
    });
  });
});
