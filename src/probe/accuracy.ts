// SPDX-License-Identifier: GPL-3.0-only
import { defined } from "../invariant";
import { failure, type Issue, type ParseResult, success } from "../result";
import { type ConsoleLine, consoleLines } from "../text/console";

/**
 * Lecture de la sortie de `PROBE_ACCURACY` (EP-05.16), fidèle à klippy/extras/probe.py (0.13) :
 * - en-tête « PROBE_ACCURACY at X:… Y:… Z:… (samples=… retract=… speed=… lift_speed=…) »
 *   (et l'ancien « probe accuracy: at X:… » encore cité par la documentation) ;
 * - une ligne « probe at x,y is z=… » par mesure ;
 * - « probe accuracy results: maximum …, minimum …, range …, average …, median …,
 *   standard deviation … » — écart-type de POPULATION (division par n), comme Klipper.
 */

export type ProbeAccuracyCode =
  | "probe.none-found"
  | "probe.multiple-runs"
  | "probe.results-mismatch"
  | "probe.samples-count-mismatch";

export interface ProbeStats {
  readonly maximum: number;
  readonly minimum: number;
  readonly range: number;
  readonly average: number;
  readonly median: number;
  readonly standardDeviation: number;
}

export interface ProbeAccuracyRun {
  readonly line: number;
  readonly position?: { readonly x: number; readonly y: number; readonly z: number };
  /** Nombre d'échantillons demandé (paramètre SAMPLES), si l'en-tête est présent. */
  readonly requestedSamples?: number;
  /** Mesures individuelles (Z en mm), dans l'ordre. */
  readonly samples: readonly number[];
  /** Statistiques de référence : celles de Klipper si présentes, sinon recalculées. */
  readonly stats: ProbeStats;
  readonly statsSource: "klipper" | "computed";
}

const FLOAT = "([-+]?\\d+(?:\\.\\d+)?)";
const HEADER = new RegExp(
  `^(?:PROBE_ACCURACY|probe accuracy:?)\\s+at\\s+X:${FLOAT}\\s+Y:${FLOAT}\\s+Z:${FLOAT}(?:\\s*\\(samples=(\\d+))?`,
  "i",
);
const SAMPLE = new RegExp(`^probe at ${FLOAT},${FLOAT} is z=${FLOAT}`, "i");
const RESULTS = new RegExp(
  `^probe accuracy results: maximum ${FLOAT}, minimum ${FLOAT}, range ${FLOAT}, average ${FLOAT}, median ${FLOAT}, standard deviation ${FLOAT}`,
  "i",
);

/** Statistiques calculées comme Klipper (médiane : moyenne des deux valeurs centrales si n pair). */
export function computeProbeStats(samples: readonly number[]): ProbeStats {
  const n = samples.length;
  if (n === 0) throw new RangeError("computeProbeStats : au moins une mesure est requise.");
  const sorted = [...samples].sort((a, b) => a - b);
  const average = samples.reduce((sum, z) => sum + z, 0) / n;
  const middle = Math.floor(n / 2);
  const at = (index: number) => defined(sorted[index], "mesure");
  const median = n % 2 === 1 ? at(middle) : (at(middle - 1) + at(middle)) / 2;
  const maximum = at(n - 1);
  const minimum = at(0);
  const variance = samples.reduce((sum, z) => sum + (z - average) ** 2, 0) / n;
  return {
    maximum,
    minimum,
    range: maximum - minimum,
    average,
    median,
    standardDeviation: Math.sqrt(variance),
  };
}

interface RunBuilder {
  line: number;
  position?: { x: number; y: number; z: number };
  requestedSamples?: number;
  samples: number[];
  reported?: ProbeStats;
}

/**
 * Remet dans l'ordre chronologique un collage affiché du plus récent au plus ancien (option de
 * certaines consoles, constatée dans un ticket réel) : si la première ligne significative est le
 * résultat et qu'une mesure ou un en-tête la suit, le texte est lu à l'envers.
 */
function chronological(lines: readonly ConsoleLine[]): readonly ConsoleLine[] {
  const keyLines = lines.filter(
    ({ content }) => HEADER.test(content) || SAMPLE.test(content) || RESULTS.test(content),
  );
  const [first, ...rest] = keyLines;
  const reversed =
    first !== undefined &&
    RESULTS.test(first.content) &&
    rest.some(({ content }) => HEADER.test(content) || SAMPLE.test(content));
  return reversed ? [...lines].reverse() : lines;
}

/**
 * Tolérance du recoupement : Klipper calcule sur des valeurs non arrondies puis imprime 6
 * décimales ; les statistiques recalculées depuis les lignes imprimées peuvent différer de ~1 µm.
 */
const TOLERANCE = 5e-6;

function statsDiffer(a: ProbeStats, b: ProbeStats): boolean {
  return (Object.keys(a) as (keyof ProbeStats)[]).some(
    (key) => Math.abs(a[key] - b[key]) > TOLERANCE,
  );
}

export function parseProbeAccuracy(
  source: string,
): ParseResult<ProbeAccuracyRun[], ProbeAccuracyCode> {
  const builders: RunBuilder[] = [];
  let current: RunBuilder | undefined;

  for (const { line, content } of chronological(consoleLines(source))) {
    const header = HEADER.exec(content);
    if (header) {
      current = {
        line,
        position: { x: Number(header[1]), y: Number(header[2]), z: Number(header[3]) },
        samples: [],
        ...(header[4] ? { requestedSamples: Number(header[4]) } : {}),
      };
      builders.push(current);
      continue;
    }
    const sample = SAMPLE.exec(content);
    if (sample) {
      if (!current || current.reported) {
        current = { line, samples: [] };
        builders.push(current);
      }
      current.samples.push(Number(sample[3]));
      continue;
    }
    const results = RESULTS.exec(content);
    if (results) {
      if (!current || current.reported) {
        current = { line, samples: [] };
        builders.push(current);
      }
      const value = (group: number) => Number(defined(results[group], "valeur"));
      current.reported = {
        maximum: value(1),
        minimum: value(2),
        range: value(3),
        average: value(4),
        median: value(5),
        standardDeviation: value(6),
      };
    }
  }

  const warnings: Issue<ProbeAccuracyCode>[] = [];
  const runs: ProbeAccuracyRun[] = [];
  for (const builder of builders) {
    if (builder.samples.length === 0 && !builder.reported) continue;
    const computed = builder.samples.length > 0 ? computeProbeStats(builder.samples) : undefined;
    if (computed && builder.reported && statsDiffer(computed, builder.reported)) {
      warnings.push({ code: "probe.results-mismatch", line: builder.line });
    }
    if (
      builder.requestedSamples !== undefined &&
      builder.samples.length > 0 &&
      builder.samples.length !== builder.requestedSamples
    ) {
      warnings.push({
        code: "probe.samples-count-mismatch",
        line: builder.line,
        params: { expected: builder.requestedSamples, found: builder.samples.length },
      });
    }
    const stats = builder.reported ?? computed;
    if (!stats) continue;
    runs.push({
      line: builder.line,
      samples: builder.samples,
      stats,
      statsSource: builder.reported ? "klipper" : "computed",
      ...(builder.position ? { position: builder.position } : {}),
      ...(builder.requestedSamples !== undefined
        ? { requestedSamples: builder.requestedSamples }
        : {}),
    });
  }

  if (runs.length === 0) return failure({ code: "probe.none-found" });
  if (runs.length > 1)
    warnings.push({ code: "probe.multiple-runs", params: { count: runs.length } });
  return success(runs, warnings);
}

export type RepeatabilityVerdict = "good" | "borderline" | "insufficient";

export interface RepeatabilityThresholds {
  /** Étendue jusqu'à laquelle la sonde est dans la norme (mm). */
  readonly goodRange: number;
  /** Au-delà : précision insuffisante pour un maillage (mm). */
  readonly maxRange: number;
  /** En dessous de ce nombre de mesures, le verdict est peu fiable. */
  readonly minSamples: number;
}

/**
 * Seuils par défaut, d'après la documentation de Klipper (Probe_Calibrate) : une étendue de
 * 0,0125 mm est « normale » (quantification par pas moteur) ; au-delà de 0,025 mm la sonde n'a
 * pas une précision suffisante pour le nivellement. Klipper mesure 10 fois par défaut.
 * Ajustables par profil d'imprimante (EP-05.11).
 */
export const DEFAULT_REPEATABILITY_THRESHOLDS: RepeatabilityThresholds = {
  goodRange: 0.0125,
  maxRange: 0.025,
  minSamples: 10,
};

export interface RepeatabilityAssessment {
  readonly verdict: RepeatabilityVerdict;
  /** true si le nombre de mesures est inférieur au minimum recommandé. */
  readonly lowSampleCount: boolean;
}

export function assessRepeatability(
  run: Pick<ProbeAccuracyRun, "stats" | "samples" | "requestedSamples">,
  thresholds: RepeatabilityThresholds = DEFAULT_REPEATABILITY_THRESHOLDS,
): RepeatabilityAssessment {
  // Marge d'arrondi : les valeurs imprimées ont 6 décimales.
  const range = run.stats.range - 1e-9;
  const verdict: RepeatabilityVerdict =
    range <= thresholds.goodRange
      ? "good"
      : range <= thresholds.maxRange
        ? "borderline"
        : "insufficient";
  const count = run.samples.length || run.requestedSamples || 0;
  return { verdict, lowSampleCount: count > 0 && count < thresholds.minSamples };
}
