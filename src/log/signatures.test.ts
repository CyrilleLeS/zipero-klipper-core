// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from "vitest";
import { readKlippyLog } from "./sessions";
import { compileSignatures, type LogSignature } from "./signatures";

const signature = (id: string, contains: string, pattern: string): LogSignature => ({
  id,
  severity: "error",
  contains,
  pattern,
  texts: { fr: { title: id, cause: "c", checks: ["v"], fix: "f" } },
  source: "test",
});

const SIGNATURES = [
  signature("tmc.short", "reports error", "^TMC '(?<stepper>[^']+)' reports error: .* s2g[ab]=1"),
  signature("tmc.error", "reports error", "^TMC '(?<stepper>[^']+)' reports error: (?<detail>.+)$"),
  signature("mcu.lost", "Lost communication", "Lost communication with MCU '(?<mcu>[^']+)'"),
];

describe("signatures d'erreurs (EP-07.04)", () => {
  it("la première signature qui reconnaît la ligne gagne ; groupes nommés en paramètres", () => {
    const recognize = compileSignatures(SIGNATURES);
    expect(
      recognize("TMC 'stepper_x' reports error: DRV_STATUS: 18000000 s2ga=1(ShortToGND_A!)"),
    ).toMatchObject({ signature: { id: "tmc.short" }, params: { stepper: "stepper_x" } });
    expect(recognize("TMC 'extruder' reports error: GSTAT: 00000001 reset=1(Reset)")).toMatchObject(
      { signature: { id: "tmc.error" }, params: { detail: "GSTAT: 00000001 reset=1(Reset)" } },
    );
    expect(recognize("webhooks client 1: New connection")).toBeUndefined();
  });

  it("expression invalide (paquet plus récent) : signature ignorée, les autres restent", () => {
    const recognize = compileSignatures([signature("broken", "x", "(?<"), ...SIGNATURES.slice(2)]);
    expect(recognize("Lost communication with MCU 'mcu'")?.signature.id).toBe("mcu.lost");
    expect(recognize("x")).toBeUndefined();
  });

  it("ligne démesurée : seul le début est examiné", () => {
    const recognize = compileSignatures(SIGNATURES);
    expect(recognize(`${"x".repeat(5000)}Lost communication with MCU 'mcu'`)).toBeUndefined();
  });

  it("dans le journal : par session, première ligne et nombre ; config et Stats ignorées", () => {
    const summary = readKlippyLog(
      [
        "Start printer at Tue Oct  6 10:00:00 2026 (1.0 1.0)",
        "===== Config file =====",
        "#*# Lost communication with MCU 'mcu'",
        "=======================",
        "Stats 10.0: Lost communication with MCU 'mcu'",
        "Receive: 99 1.0 1.0 12: seq: 12, shutdown static_string_id=Lost communication with MCU 'mcu'",
        "Transition to shutdown state: Lost communication with MCU 'EBBCan'",
        "Lost communication with MCU 'mcu'",
        "Restarting printer",
        "Start printer at Tue Oct  6 10:05:00 2026 (2.0 2.0)",
        "TMC 'stepper_x' reports error: GSTAT: 00000001 reset=1(Reset)",
      ].join("\n"),
      { signatures: SIGNATURES },
    );
    const [first, second] = summary.sessions;
    // La ligne d'arrêt marque le problème comme cause de l'arrêt.
    expect(first?.problems).toEqual([
      {
        id: "mcu.lost",
        severity: "error",
        line: 7,
        count: 2,
        stopped: true,
        params: { mcu: "EBBCan" },
      },
    ]);
    expect(second?.problems.map((p) => [p.id, p.stopped])).toEqual([["tmc.error", false]]);
    // Sans signatures : aucun problème reconnu.
    const plain = readKlippyLog("Transition to shutdown state: Lost communication with MCU 'mcu'");
    expect(plain.sessions[0]?.problems).toEqual([]);
  });
});

describe("problème cause d'un échec de chargement", () => {
  it("message final de la pile qui suit « Config error » : stopped ; code cité ignoré", () => {
    const summary = readKlippyLog(
      [
        "Start printer at Tue Oct  6 10:00:00 2026 (1.0 1.0)",
        "Config error",
        "Traceback (most recent call last):",
        '  File "/home/pi/klipper/klippy/mcu.py", line 906, in check_timeout',
        "    self._printer.invoke_shutdown(\"Lost communication with MCU '%s'\" % (",
        "serialhdl.error: Lost communication with MCU 'mcu'",
      ].join("\n"),
      { signatures: SIGNATURES },
    );
    expect(summary.sessions[0]?.problems).toEqual([
      expect.objectContaining({ id: "mcu.lost", line: 6, stopped: true, params: { mcu: "mcu" } }),
    ]);
  });
});
