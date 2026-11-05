// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from "vitest";
import { computeRotationDistance, rotationDistanceSnippet, roundTo3 } from "./rotation-distance";

describe("rotation_distance de l'extrudeur (EP-24.06, docs/Rotation_Distance.md de Klipper)", () => {
  it("ancienne × extrudé réel / demandé, arrondi à trois décimales", () => {
    // Repère à 70 mm, 50 mm demandés, repère à 22 mm ensuite : 48 mm réellement entrés.
    const result = computeRotationDistance({
      previous: 22.6789511,
      requested: 50,
      markBefore: 70,
      markAfter: 22,
    });
    expect(result).toEqual({
      ok: true,
      value: { actual: 48, deviation: -2, value: 21.772 },
      warnings: [],
    });
  });

  it("plus de 2 mm d'écart : refaire la mesure (conseil de Klipper)", () => {
    const result = computeRotationDistance({
      previous: 7.71,
      requested: 50,
      markBefore: 70.1,
      markAfter: 23.3,
    });
    expect(result.ok && result.value.actual).toBe(46.8);
    expect(result.ok && result.value.value).toBe(roundTo3((7.71 * 46.8) / 50));
    expect(result.warnings).toEqual([{ code: "rotation.remeasure", params: { deviation: -3.2 } }]);
  });

  it("extrudeur qui pousse trop : valeur plus grande, écart positif", () => {
    const result = computeRotationDistance({
      previous: 33.5,
      requested: 50,
      markBefore: 70,
      markAfter: 19,
    });
    expect(result).toMatchObject({ ok: true, value: { actual: 51, deviation: 1, value: 34.17 } });
    expect(result.warnings).toEqual([]);
  });

  it("saisies impossibles refusées avec un code", () => {
    const base = { previous: 22.6, requested: 50, markBefore: 70, markAfter: 20 };
    const code = (input: typeof base) => {
      const result = computeRotationDistance(input);
      return result.ok ? null : result.error.code;
    };
    expect(code({ ...base, previous: 0 })).toBe("rotation.invalid-previous");
    expect(code({ ...base, previous: Number.NaN })).toBe("rotation.invalid-previous");
    expect(code({ ...base, requested: -50 })).toBe("rotation.invalid-requested");
    expect(code({ ...base, markBefore: Number.POSITIVE_INFINITY })).toBe("rotation.invalid-mark");
    expect(code({ ...base, markAfter: -1 })).toBe("rotation.invalid-mark");
    expect(code({ ...base, markAfter: 70 })).toBe("rotation.not-extruded");
    expect(code({ ...base, markAfter: 75 })).toBe("rotation.not-extruded");
  });

  it("bloc de configuration : section et point décimal", () => {
    expect(rotationDistanceSnippet(21.772)).toBe("[extruder]\nrotation_distance: 21.772");
    expect(rotationDistanceSnippet(34.17, "extruder1")).toBe(
      "[extruder1]\nrotation_distance: 34.170",
    );
    expect(roundTo3(1.0005)).toBe(1.001);
  });
});
