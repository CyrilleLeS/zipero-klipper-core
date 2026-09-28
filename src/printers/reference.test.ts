// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from "vitest";
import { findReferencePrinter, REFERENCE_PRINTERS } from "./reference";

describe("profils de référence", () => {
  it("contient les 108 imprimantes des configurations de Klipper, identifiants uniques", () => {
    expect(REFERENCE_PRINTERS).toHaveLength(108);
    expect(new Set(REFERENCE_PRINTERS.map((p) => p.id)).size).toBe(108);
  });

  it("cite la source exacte de chaque profil", () => {
    for (const p of REFERENCE_PRINTERS) {
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
});
