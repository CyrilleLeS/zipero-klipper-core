// SPDX-License-Identifier: GPL-3.0-only

/**
 * Courbes des lignes `Stats` du journal (EP-07.05). Klipper écrit une ligne toutes les quelques
 * secondes : `Stats <horloge>: <groupe>: clé=valeur … clé=valeur …`. Lecture et calculs repris du
 * script de Klipper `scripts/graphstats.py` :
 * - un mot sans `=` ouvre un groupe (`mcu:`, `heater_bed:`, `EBBCan:`) ; seules certaines clés
 *   sont propres au groupe (`mcu_task_avg`, `temp`, `target`…), les autres sont globales
 *   (`sysload`, `print_time`…) ; une ligne sans `print_time` est ignorée ;
 * - charge d'une carte : 100 × (mcu_task_avg + 3 × mcu_task_stddev) / 0,0025, nulle pendant les
 *   15 premières secondes ;
 * - retransmissions : octets retransmis par seconde, entre deux lignes (compteur cumulé).
 * Points gardés : 2 000 par session au plus (un sur deux est retiré quand la limite est atteinte).
 */

const APPLY_PREFIX = new Set([
  "mcu_awake",
  "mcu_task_avg",
  "mcu_task_stddev",
  "bytes_write",
  "bytes_read",
  "bytes_retransmit",
  "freq",
  "adj",
  "target",
  "temp",
  "pwm",
]);
const TASK_MAX = 0.0025;
const MAX_POINTS = 2000;

export type LogStatKind = "temperature" | "mcu-load" | "retransmit" | "sysload";

export interface LogStatSeries {
  /** Capteur, chauffage ou carte (`extruder`, `heater_bed`, `mcu`, `EBBCan`) ; vide pour l'hôte. */
  readonly name: string;
  readonly kind: LogStatKind;
  /** Valeur à chaque instant de `times` ; null si absente de cette ligne. */
  readonly values: readonly (number | null)[];
  /** Consignes (températures des chauffages seulement). */
  readonly targets?: readonly (number | null)[];
}

export interface LogStats {
  /** Secondes depuis la première ligne `Stats` de la session. */
  readonly times: readonly number[];
  readonly series: readonly LogStatSeries[];
}

interface Sample {
  time: number;
  values: Map<string, number>;
}

/** Collecte des lignes `Stats` d'une session. */
export function createStatsCollector() {
  let samples: Sample[] = [];
  let stride = 1;
  let seen = 0;
  let start: number | undefined;
  let lastTime: number | undefined;
  const lastRetransmit = new Map<string, number>();

  return {
    push(line: string): void {
      const parts = line.split(/\s+/).filter(Boolean);
      if (parts[0] !== "Stats" || !parts[1]?.endsWith(":")) return;
      const time = Number(parts[1].slice(0, -1));
      if (!Number.isFinite(time)) return;
      const keys = new Map<string, string>();
      let prefix = "mcu";
      for (const part of parts.slice(2)) {
        const equal = part.indexOf("=");
        if (equal < 0) {
          prefix = part.replace(/:$/, "");
          continue;
        }
        const name = part.slice(0, equal);
        keys.set(APPLY_PREFIX.has(name) ? `${prefix}\u0000${name}` : name, part.slice(equal + 1));
      }
      if (!keys.has("print_time")) return;
      start ??= time;
      const values = new Map<string, number>();
      const number = (key: string) => {
        const value = Number(keys.get(key));
        return Number.isFinite(value) ? value : undefined;
      };
      const groups = new Set<string>();
      for (const key of keys.keys()) {
        const split = key.indexOf("\u0000");
        if (split >= 0) groups.add(key.slice(0, split));
      }
      for (const group of groups) {
        const at = (name: string) => number(`${group}\u0000${name}`);
        const avg = at("mcu_task_avg");
        const stddev = at("mcu_task_stddev");
        if (avg !== undefined && stddev !== undefined) {
          values.set(
            `mcu-load\u0000${group}`,
            time - start < 15 ? 0 : (100 * (avg + 3 * stddev)) / TASK_MAX,
          );
        }
        const retransmit = at("bytes_retransmit");
        if (retransmit !== undefined) {
          const previous = lastRetransmit.get(group);
          if (previous !== undefined && lastTime !== undefined && time > lastTime) {
            values.set(
              `retransmit\u0000${group}`,
              Math.max(0, (retransmit - previous) / (time - lastTime)),
            );
          }
          lastRetransmit.set(group, retransmit);
        }
        const temp = at("temp");
        if (temp !== undefined) values.set(`temperature\u0000${group}`, temp);
        const target = at("target");
        if (target !== undefined) values.set(`target\u0000${group}`, target);
      }
      const sysload = number("sysload");
      if (sysload !== undefined) values.set("sysload\u0000", sysload);
      lastTime = time;

      // Sous-échantillonnage : un point sur `stride` ; la limite atteinte, un sur deux retiré.
      seen++;
      if ((seen - 1) % stride !== 0) return;
      samples.push({ time: time - start, values });
      if (samples.length > MAX_POINTS) {
        samples = samples.filter((_, index) => index % 2 === 0);
        stride *= 2;
      }
    },

    finish(): LogStats | undefined {
      if (samples.length < 2) return undefined;
      const keys = new Set<string>();
      for (const sample of samples) for (const key of sample.values.keys()) keys.add(key);
      const series: LogStatSeries[] = [];
      for (const key of [...keys].sort()) {
        const [kind, name = ""] = key.split("\u0000") as [string, string];
        if (kind === "target") continue;
        const values = samples.map((s) => s.values.get(key) ?? null);
        const targetKey = `target\u0000${name}`;
        const targets = keys.has(targetKey)
          ? samples.map((s) => s.values.get(targetKey) ?? null)
          : undefined;
        series.push({
          name,
          kind: kind as LogStatKind,
          values,
          ...(targets ? { targets } : {}),
        });
      }
      return { times: samples.map((s) => s.time), series };
    },
  };
}
