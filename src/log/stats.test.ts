// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from "vitest";
import { readKlippyLog } from "./sessions";
import { createStatsCollector } from "./stats";

/** Ligne `Stats` au format de Klipper (deux cartes, deux chauffages, un capteur, l'hôte). */
const stats = (time: number, retransmit: number, ebbRetransmit: number, temp: number) =>
  [
    `Stats ${time}: gcodein=0`,
    `mcu: mcu_awake=0.010 mcu_task_avg=0.000010 mcu_task_stddev=0.000005 bytes_write=2792 bytes_read=5729 bytes_retransmit=${retransmit}`,
    `EBBCan: mcu_awake=0.004 mcu_task_avg=0.000050 mcu_task_stddev=0.000010 bytes_retransmit=${ebbRetransmit}`,
    `heater_bed: target=60 temp=${temp} pwm=0.500`,
    `MAX31865: temp=21.5`,
    "sysload=0.25 cputime=1.739 memavail=3153064",
    `print_time=${time} buffer_time=0.5 print_stall=0`,
    `extruder: target=0 temp=${temp - 30} pwm=0.000`,
  ].join(" ");

describe("courbes des lignes Stats (EP-07.05)", () => {
  it("charge des cartes (calcul de graphstats.py), retransmissions par seconde, températures, hôte", () => {
    const collector = createStatsCollector();
    collector.push(stats(100, 10, 0, 50));
    collector.push(stats(110, 10, 0, 52));
    collector.push(stats(120, 60, 400, 55));
    const result = collector.finish();
    expect(result?.times).toEqual([0, 10, 20]);
    const series = (kind: string, name: string) =>
      result?.series.find((s) => s.kind === kind && s.name === name);
    // 100 × (0,00001 + 3 × 0,000005) / 0,0025 = 1 %, nulle pendant les 15 premières secondes.
    expect(series("mcu-load", "mcu")?.values.map((v) => v?.toFixed(2))).toEqual([
      "0.00",
      "0.00",
      "1.00",
    ]);
    expect(series("mcu-load", "EBBCan")?.values.at(-1)).toBeCloseTo(3.2);
    expect(series("retransmit", "mcu")?.values).toEqual([null, 0, 5]);
    expect(series("retransmit", "EBBCan")?.values).toEqual([null, 0, 40]);
    expect(series("temperature", "heater_bed")).toEqual({
      name: "heater_bed",
      kind: "temperature",
      values: [50, 52, 55],
      targets: [60, 60, 60],
    });
    expect(series("temperature", "MAX31865")?.targets).toBeUndefined();
    expect(series("temperature", "extruder")?.values).toEqual([20, 22, 25]);
    expect(series("sysload", "")?.values).toEqual([0.25, 0.25, 0.25]);
  });

  it("ligne sans print_time, horloge illisible ou une seule ligne : rien", () => {
    const collector = createStatsCollector();
    collector.push("Stats 10.0: gcodein=0 mcu: mcu_task_avg=0.1");
    collector.push("Stats abc: print_time=1");
    collector.push("Statistiques : rien");
    collector.push(stats(20, 0, 0, 20));
    expect(collector.finish()).toBeUndefined();
  });

  it("journal très long : 2 000 points au plus, répartis sur toute la durée", () => {
    const collector = createStatsCollector();
    for (let k = 0; k < 10_000; k++) collector.push(stats(k, k, k, 20));
    const result = collector.finish();
    expect(result?.times.length).toBeLessThanOrEqual(2000);
    expect(result?.times.length).toBeGreaterThan(1000);
    expect(result?.times.at(-1)).toBeGreaterThan(9000);
  });

  it("dans le journal : courbes rattachées à leur session", () => {
    const summary = readKlippyLog(
      [
        "Start printer at Tue Oct  6 10:00:00 2026 (1.0 1.0)",
        stats(100, 0, 0, 20),
        stats(105, 0, 0, 25),
        "Restarting printer",
        "Start printer at Tue Oct  6 10:05:00 2026 (2.0 2.0)",
        stats(200, 0, 0, 20),
      ].join("\n"),
    );
    expect(summary.sessions[0]?.stats?.times).toEqual([0, 5]);
    expect(summary.sessions[1]?.stats).toBeUndefined();
  });
});
