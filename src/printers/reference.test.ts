// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from "vitest";
import { findReferencePrinter, REFERENCE_PRINTERS } from "./reference";

describe("profils de référence", () => {
  it("contient les 108 imprimantes de Klipper et les 6 profils des fabricants, identifiants uniques", () => {
    expect(REFERENCE_PRINTERS).toHaveLength(114);
    expect(new Set(REFERENCE_PRINTERS.map((p) => p.id)).size).toBe(114);
  });

  it("cite la source exacte de chaque profil", () => {
    for (const p of REFERENCE_PRINTERS.filter((p) => p.year !== undefined)) {
      expect(p.source).toEqual({
        repository: "Klipper3d/klipper",
        commit: "214fdb2877",
        license: "GPL-3.0-only",
        path: `config/printer-${p.id}.cfg`,
      });
    }
  });

  it("a des courses cohérentes (min < max, dimensions plausibles pour une imprimante)", () => {
    for (const { id, mechanics } of REFERENCE_PRINTERS) {
      const t = mechanics.travel;
      if (!t) continue;
      expect(t.minX, id).toBeLessThan(t.maxX);
      expect(t.minY, id).toBeLessThan(t.maxY);
      expect(t.maxX - t.minX, id).toBeLessThan(1500);
      expect(t.maxY - t.minY, id).toBeLessThan(1500);
    }
  });

  it("ses vis screws_tilt_adjust sont au moins 3, comme Klipper l'exige", () => {
    for (const { id, mechanics } of REFERENCE_PRINTERS) {
      if (mechanics.screws?.source === "screws_tilt_adjust") {
        expect(mechanics.screws.points.length, id).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("retrouve les machines prioritaires présentes dans Klipper", () => {
    expect(findReferencePrinter("creality-ender3-v2-2020")).toMatchObject({
      name: "Creality Ender 3 V2",
      mechanics: {
        kinematics: "cartesian",
        travel: { minX: 0, maxX: 235, minY: 0, maxY: 235, maxZ: 250 },
      },
    });
    const cr10v3 = findReferencePrinter("creality-cr10-v3-2020");
    expect(cr10v3?.mechanics.screws).toMatchObject({ source: "bed_screws" });
    expect(cr10v3?.mechanics.screws?.points).toHaveLength(4);
    expect(findReferencePrinter("inconnue")).toBeUndefined();
  });

  it("cite le dépôt du fabricant, à un commit complet, pour les machines absentes de Klipper", () => {
    const makers = REFERENCE_PRINTERS.filter((p) => p.year === undefined);
    expect(makers.map((p) => p.id)).toEqual([
      "voron-2.4-250",
      "voron-2.4-300",
      "voron-2.4-350",
      "creality-k1",
      "sovol-sv08",
      "qidi-plus4",
    ]);
    for (const { id, source } of makers) {
      expect(source.repository, id).not.toBe("Klipper3d/klipper");
      expect(source.commit, id).toMatch(/^[0-9a-f]{40}$/);
    }
    expect(findReferencePrinter("sovol-sv08")?.mechanics).toMatchObject({
      kinematics: "corexy",
      probe: { type: "probe", xOffset: -17, yOffset: 10 },
      mesh: { min: [10, 10], max: [333, 340] },
    });
  });
});
