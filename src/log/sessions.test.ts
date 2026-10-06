// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from "vitest";
import { createLogReader, readKlippyLog } from "./sessions";

const versions = [
  "Starting Klippy...",
  "Args: ['/home/pi/klipper/klippy/klippy.py', '/home/pi/printer_data/config/printer.cfg']",
  "Git version: 'v0.12.0-301-g1a2b3c4d'",
  "Branch: master",
  "Remote: origin",
  "Tracked URL: https://github.com/Klipper3d/klipper",
  "CPU: 4 core ARMv7 Processor rev 3 (v7l)",
  "Device: Raspberry Pi 4 Model B Rev 1.4",
  "Linux: Linux version 6.1.21-v7l+",
  "Python: '3.9.2 (default, Feb 28 2021, 17:03:44) \\n[GCC 10.2.1 20210110]'",
];
const start = (epoch: number) => `Start printer at Mon Oct  6 10:00:00 2026 (${epoch}.2 123.4)`;
const config = [
  "===== Config file =====",
  "[printer]",
  "kinematics = cartesian",
  "=======================",
];
const mcu = [
  "Loaded MCU 'mcu' 107 commands (v0.12.0-301-g1a2b3c4d / gcc: (GCC) 10.3.1 binutils: (GNU Binutils) 2.36.1)",
  "MCU 'mcu' config: ADC_MAX=4095 BUS_PINS_spi1=PA6,PA7,PA5 CLOCK_FREQ=180000000 MCU=stm32f446xx STATS_SUMSQ_BASE=256",
];

describe("readKlippyLog (EP-07.02)", () => {
  it("démarrage puis RESTART : deux sessions, versions, config, MCU", () => {
    const summary = readKlippyLog(
      [
        ...versions,
        start(1791280800),
        ...config,
        ...mcu,
        "Restarting printer",
        start(1791281000),
        ...mcu,
      ].join("\n"),
    );
    expect(summary.lines).toBe(21);
    expect(summary.sessions).toHaveLength(2);
    const [first, second] = summary.sessions;
    expect(first).toMatchObject({
      startLine: 11,
      startedAt: 1791280800.2,
      partial: false,
      gitVersion: "v0.12.0-301-g1a2b3c4d",
      branch: "master",
      python: "3.9.2",
      cpu: "4 core ARMv7 Processor rev 3 (v7l)",
      device: "Raspberry Pi 4 Model B Rev 1.4",
      config: "[printer]\nkinematics = cartesian",
      endedBy: "restart",
      mcus: [
        {
          name: "mcu",
          commands: 107,
          version: "v0.12.0-301-g1a2b3c4d",
          chip: "stm32f446xx",
          clockFrequency: 180_000_000,
        },
      ],
    });
    // Le redémarrage garde les versions du processus ; pas de nouvelle config dans le journal.
    expect(second).toMatchObject({
      startLine: 19,
      gitVersion: "v0.12.0-301-g1a2b3c4d",
      endedBy: "end-of-file",
    });
    expect(second?.config).toBeUndefined();
  });

  it("plusieurs MCU (dont une carte CAN) et arrêts avec leur ligne", () => {
    const summary = readKlippyLog(
      [
        ...versions,
        start(1),
        ...mcu,
        "Loaded MCU 'EBBCan' 112 commands (v0.12.0-301-g1a2b3c4d / gcc: x)",
        "MCU 'EBBCan' config: CLOCK_FREQ=64000000 MCU=stm32g0b1xx",
        "Transition to shutdown state: Lost communication with MCU 'EBBCan'",
        "Transition to shutdown state: MCU 'mcu' shutdown: Timer too close",
      ].join("\n"),
    );
    const [session] = summary.sessions;
    expect(session?.mcus.map((m) => [m.name, m.chip])).toEqual([
      ["mcu", "stm32f446xx"],
      ["EBBCan", "stm32g0b1xx"],
    ]);
    expect(session?.shutdowns).toEqual([
      { line: 16, reason: "Lost communication with MCU 'EBBCan'" },
      { line: 17, reason: "MCU 'mcu' shutdown: Timer too close" },
    ]);
  });

  it("journal tourné : session partielle (versions et config recopiées), puis un vrai démarrage", () => {
    const summary = readKlippyLog(
      [
        "Git version: 'v0.12.0-301-g1a2b3c4d'",
        "Branch: master",
        ...config,
        "=============== Log rollover at Tue Oct  7 00:00:00 2026 ===============",
        "Stats 120.0: gcodein=0",
        "Restarting printer",
        start(2),
      ].join("\n"),
    );
    expect(summary.rollovers).toBe(1);
    expect(summary.sessions).toHaveLength(2);
    expect(summary.sessions[0]).toMatchObject({
      partial: true,
      startLine: 3,
      gitVersion: "v0.12.0-301-g1a2b3c4d",
      config: "[printer]\nkinematics = cartesian",
      endedBy: "restart",
    });
    expect(summary.sessions[1]).toMatchObject({ partial: false, startedAt: 2.2 });
  });

  it("nouveau processus : les versions du précédent ne débordent pas", () => {
    const summary = readKlippyLog(
      [...versions, start(1), "Starting Klippy...", "Git version: 'v0.13.0'", start(2)].join("\n"),
    );
    expect(summary.sessions.map((s) => s.gitVersion)).toEqual(["v0.12.0-301-g1a2b3c4d", "v0.13.0"]);
    expect(summary.sessions.map((s) => s.endedBy)).toEqual(["new-process", "end-of-file"]);
  });

  it("échec du chargement : cause tirée de la dernière ligne de la pile Python", () => {
    const summary = readKlippyLog(
      [
        ...versions,
        start(1),
        "Unable to open config file /home/pi/printer_data/config/printer.cfg",
        "Config error",
        "Traceback (most recent call last):",
        '  File "/home/pi/klipper/klippy/configfile.py", line 158, in _read_config_file',
        "FileNotFoundError: [Errno 2] No such file or directory: 'printer.cfg'",
        "",
        "During handling of the above exception, another exception occurred:",
        "",
        "Traceback (most recent call last):",
        '  File "/home/pi/klipper/klippy/klippy.py", line 175, in _connect',
        "configparser.Error: Unable to open config file /home/pi/printer_data/config/printer.cfg",
        "webhooks client 1: New connection",
        ...mcu,
      ].join("\n"),
    );
    const [session] = summary.sessions;
    expect(session?.configError).toBe(
      "Unable to open config file /home/pi/printer_data/config/printer.cfg",
    );
    // La lecture reprend après la pile.
    expect(session?.mcus[0]?.chip).toBe("stm32f446xx");
  });

  it("fins de ligne Windows, extrait sans démarrage, journal vide", () => {
    const crlf = readKlippyLog([...versions, start(1), ...mcu].join("\r\n"));
    expect(crlf.sessions[0]?.mcus[0]?.chip).toBe("stm32f446xx");
    const excerpt = readKlippyLog(
      "Transition to shutdown state: Move out of range: 300.000 0.000 0.000 [0.000]",
    );
    expect(excerpt.sessions).toEqual([
      expect.objectContaining({
        partial: true,
        startLine: 1,
        shutdowns: [expect.objectContaining({ line: 1 })],
      }),
    ]);
    expect(readKlippyLog("")).toEqual({ lines: 0, sessions: [], rollovers: 0 });
  });

  it("configuration démesurée : tronquée et signalée", () => {
    const reader = createLogReader();
    reader.push(start(1));
    reader.push("===== Config file =====");
    const line = "x".repeat(1000);
    for (let k = 0; k < 2500; k++) reader.push(line);
    reader.push("=======================");
    const [session] = reader.finish().sessions;
    expect(session?.configTruncated).toBe(true);
    expect(session?.config?.length).toBeLessThanOrEqual(2_000_000);
  });
});
