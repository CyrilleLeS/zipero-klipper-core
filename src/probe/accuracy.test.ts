// SPDX-License-Identifier: GPL-3.0-only
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { respondInfo } from "../mesh/klipper-format.fixture";
import { assessRepeatability, computeProbeStats, parseProbeAccuracy } from "./accuracy";

/** Exemple repris de la documentation officielle de Klipper (Probe_Calibrate.md), via OctoPrint. */
const fromKlipperDocs = `Send: PROBE_ACCURACY
Recv: // probe accuracy: at X:0.000 Y:0.000 Z:10.000
Recv: // and read 10 times with speed of 5 mm/s
Recv: // probe at -0.003,0.005 is z=2.506948
Recv: // probe at -0.003,0.005 is z=2.519448
Recv: // probe at -0.003,0.005 is z=2.519448
Recv: // probe at -0.003,0.005 is z=2.506948
Recv: // probe at -0.003,0.005 is z=2.519448
Recv: // probe at -0.003,0.005 is z=2.519448
Recv: // probe at -0.003,0.005 is z=2.506948
Recv: // probe at -0.003,0.005 is z=2.506948
Recv: // probe at -0.003,0.005 is z=2.519448
Recv: // probe at -0.003,0.005 is z=2.506948
Recv: // probe accuracy results: maximum 2.519448, minimum 2.506948, range 0.012500, average 2.513198, median 2.513198, standard deviation 0.006250
Recv: ok`;

/** Format actuel (probe.py 0.13 : en-tête PROBE_ACCURACY + respond_info). */
const current = [
  respondInfo(
    "PROBE_ACCURACY at X:117.500 Y:117.500 Z:10.000 (samples=5 retract=2.000 speed=5.0 lift_speed=5.0)\n",
  ),
  ...[1.915, 1.9175, 1.9125, 1.915, 1.9175].map((z) =>
    respondInfo(`probe at 117.500,117.500 is z=${z.toFixed(6)}`),
  ),
  respondInfo(
    "probe accuracy results: maximum 1.917500, minimum 1.912500, range 0.005000, average 1.915500, median 1.915000, standard deviation 0.001871",
  ),
].join("\n");

describe("parseProbeAccuracy", () => {
  it("lit l'exemple de la documentation de Klipper (ancien en-tête, préfixes OctoPrint)", () => {
    const result = parseProbeAccuracy(fromKlipperDocs);
    if (!result.ok) throw new Error("échec inattendu");
    expect(result.warnings).toEqual([]);
    const [run] = result.value;
    expect(run?.position).toEqual({ x: 0, y: 0, z: 10 });
    expect(run?.samples).toHaveLength(10);
    expect(run?.statsSource).toBe("klipper");
    expect(run?.stats).toEqual({
      maximum: 2.519448,
      minimum: 2.506948,
      range: 0.0125,
      average: 2.513198,
      median: 2.513198,
      standardDeviation: 0.00625,
    });
  });

  it("lit le format actuel avec le nombre d'échantillons demandé", () => {
    const result = parseProbeAccuracy(current);
    if (!result.ok) throw new Error("échec inattendu");
    expect(result.warnings).toEqual([]);
    expect(result.value[0]).toMatchObject({
      line: 1,
      position: { x: 117.5, y: 117.5, z: 10 },
      requestedSamples: 5,
      samples: [1.915, 1.9175, 1.9125, 1.915, 1.9175],
    });
  });

  it("recalcule les statistiques si seules les mesures sont collées", () => {
    const onlySamples = current.split("\n").slice(1, 6).join("\n");
    const result = parseProbeAccuracy(onlySamples);
    if (!result.ok) throw new Error("échec inattendu");
    expect(result.value[0]?.statsSource).toBe("computed");
    expect(result.value[0]?.stats.range).toBeCloseTo(0.005, 9);
    expect(result.value[0]?.stats.standardDeviation).toBeCloseTo(0.001871, 6);
  });

  it("accepte la seule ligne de résultats", () => {
    const result = parseProbeAccuracy(current.split("\n").at(-1) ?? "");
    expect(result.ok && result.value[0]?.stats.range).toBe(0.005);
  });

  it("signale des résultats incohérents avec les mesures collées", () => {
    const tampered = current.replace("range 0.005000", "range 0.050000");
    const result = parseProbeAccuracy(tampered);
    expect(result.warnings.map((w) => w.code)).toEqual(["probe.results-mismatch"]);
  });

  it("signale un collage incomplet (moins de mesures que demandé)", () => {
    const partial = current
      .split("\n")
      .filter((_, index) => index !== 3)
      .join("\n");
    const result = parseProbeAccuracy(partial);
    expect(result.warnings).toContainEqual({
      code: "probe.samples-count-mismatch",
      line: 1,
      params: { expected: 5, found: 4 },
    });
  });

  it("sépare plusieurs exécutions successives", () => {
    const result = parseProbeAccuracy(`${current}\n${fromKlipperDocs}`);
    if (!result.ok) throw new Error("échec inattendu");
    expect(result.value).toHaveLength(2);
    expect(result.warnings).toContainEqual({ code: "probe.multiple-runs", params: { count: 2 } });
  });

  it("aucune mesure dans le texte", () => {
    expect(parseProbeAccuracy("ok")).toEqual({
      ok: false,
      error: { code: "probe.none-found" },
      warnings: [],
    });
  });
});

describe("computeProbeStats", () => {
  it("reproduit les statistiques imprimées par Klipper (exemple de la documentation)", () => {
    const samples = [
      2.506948, 2.519448, 2.519448, 2.506948, 2.519448, 2.519448, 2.506948, 2.506948, 2.519448,
      2.506948,
    ];
    const stats = computeProbeStats(samples);
    expect(stats.range).toBeCloseTo(0.0125, 9);
    expect(stats.average).toBeCloseTo(2.513198, 6);
    expect(stats.median).toBeCloseTo(2.513198, 6);
    expect(stats.standardDeviation).toBeCloseTo(0.00625, 9);
  });

  it("refuse une liste vide", () => {
    expect(() => computeProbeStats([])).toThrow(RangeError);
  });

  it("médiane : valeur centrale si n impair", () => {
    expect(computeProbeStats([3, 1, 2]).median).toBe(2);
  });

  it("propriétés : min ≤ médiane, moyenne ≤ max ; écart-type ≤ étendue / 2", () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0, max: 5, noNaN: true }), { minLength: 1, maxLength: 50 }),
        (samples) => {
          const s = computeProbeStats(samples);
          expect(s.minimum).toBeLessThanOrEqual(s.median + 1e-12);
          expect(s.median).toBeLessThanOrEqual(s.maximum + 1e-12);
          expect(s.minimum).toBeLessThanOrEqual(s.average + 1e-12);
          expect(s.average).toBeLessThanOrEqual(s.maximum + 1e-12);
          expect(s.standardDeviation).toBeLessThanOrEqual(s.range / 2 + 1e-12);
        },
      ),
    );
  });
});

describe("assessRepeatability", () => {
  const run = (range: number, samples = 10) => ({
    samples: Array.from({ length: samples }, () => 0),
    stats: { maximum: range, minimum: 0, range, average: 0, median: 0, standardDeviation: 0 },
  });

  it.each([
    [0, "good"],
    [0.0125, "good"],
    [0.0175, "borderline"],
    [0.025, "borderline"],
    [0.0251, "insufficient"],
  ] as const)("étendue %d mm → %s", (range, verdict) => {
    expect(assessRepeatability(run(range)).verdict).toBe(verdict);
  });

  it("signale un nombre de mesures trop faible pour conclure", () => {
    expect(assessRepeatability(run(0.005, 3)).lowSampleCount).toBe(true);
    expect(assessRepeatability(run(0.005, 10)).lowSampleCount).toBe(false);
  });

  it("utilise le nombre demandé quand seules les statistiques sont connues", () => {
    expect(assessRepeatability({ ...run(0.005, 0), requestedSamples: 5 }).lowSampleCount).toBe(
      true,
    );
  });

  it("ne conclut pas à un manque de mesures quand leur nombre est inconnu", () => {
    expect(assessRepeatability(run(0.005, 0)).lowSampleCount).toBe(false);
  });
});
