// SPDX-License-Identifier: GPL-3.0-only
import type { ConfigSection } from "./ini";
import { KLIPPER_SCHEMA } from "./schema";
import signatures from "./schema/firmware-signatures.json" with { type: "json" };
import type { ConfigSchema } from "./validate";

/**
 * Firmwares pris en charge (EP-01.17, ADR 0022) : Klipper et les forks dont le code est public,
 * chacun avec son schéma généré depuis son code (scripts/schema). Elegoo (Neptune 4) ne publie pas
 * ses sources : pas de schéma. Les schémas des forks sont chargés à la demande.
 */
export const FIRMWARES = [
  "klipper",
  "kalico",
  "creality-k1",
  "qidi",
  "qidi-plus4",
  "sovol-sv08",
] as const;

export type FirmwareId = (typeof FIRMWARES)[number];

const asSchema = (module: { default: unknown }) => module.default as ConfigSchema;

/** Schéma d'un firmware ; celui de Klipper est embarqué, les autres téléchargés au besoin. */
export function loadSchema(firmware: FirmwareId): Promise<ConfigSchema> {
  switch (firmware) {
    case "klipper":
      return Promise.resolve(KLIPPER_SCHEMA);
    case "kalico":
      return import("./schema/kalico-1f791b4d74.json", { with: { type: "json" } }).then(asSchema);
    case "creality-k1":
      return import("./schema/creality-k1-e09f36e6ad.json", { with: { type: "json" } }).then(
        asSchema,
      );
    case "qidi":
      return import("./schema/qidi-653d7a8f6e.json", { with: { type: "json" } }).then(asSchema);
    case "qidi-plus4":
      return import("./schema/qidi-plus4-4bb7c63379.json", { with: { type: "json" } }).then(
        asSchema,
      );
    case "sovol-sv08":
      return import("./schema/sovol-sv08-a60644875f.json", { with: { type: "json" } }).then(
        asSchema,
      );
  }
}

export interface FirmwareCandidate {
  readonly firmware: FirmwareId;
  readonly score: number;
  /** Indices trouvés : « [prtouch_v2] », « [stepper_z] endstop_pin_reverse ». */
  readonly evidence: readonly string[];
}

export interface FirmwareDetection {
  /** Firmware le plus probable ; Klipper si aucun indice. */
  readonly firmware: FirmwareId;
  /** Deux forks à égalité : le choix revient à l'utilisateur. */
  readonly ambiguous: boolean;
  readonly candidates: readonly FirmwareCandidate[];
}

interface Signature {
  readonly sections: readonly string[];
  readonly options: readonly (readonly [string, string])[];
}

const SIGNATURES = signatures as unknown as Readonly<
  Record<Exclude<FirmwareId, "klipper">, Signature>
>;

/** Poids d'un indice : une section propre au fork pèse plus qu'une option. */
const SECTION_WEIGHT = 3;

/**
 * Détecte le firmware d'après la configuration : sections et options que seul un fork connaît
 * (générées depuis les codes, `firmware-signatures.json`).
 */
export function detectFirmware(sections: readonly ConfigSection[]): FirmwareDetection {
  const candidates: FirmwareCandidate[] = [];
  for (const [firmware, signature] of Object.entries(SIGNATURES) as [
    Exclude<FirmwareId, "klipper">,
    Signature,
  ][]) {
    const evidence: string[] = [];
    let score = 0;
    const optionRules = signature.options.map(
      ([regex, option]) => [new RegExp(regex), option] as const,
    );
    for (const section of sections) {
      const module = section.name.split(/\s+/)[0] ?? "";
      const prefixed = section.name.includes(" ");
      if (signature.sections.includes(prefixed ? `${module} ` : module)) {
        score += SECTION_WEIGHT;
        evidence.push(`[${section.name}]`);
      }
      for (const option of section.options.keys()) {
        if (optionRules.some(([pattern, name]) => name === option && pattern.test(section.name))) {
          score += 1;
          evidence.push(`[${section.name}] ${option}`);
        }
      }
    }
    if (score > 0) candidates.push({ firmware, score, evidence });
  }
  candidates.sort(
    (a, b) => b.score - a.score || FIRMWARES.indexOf(a.firmware) - FIRMWARES.indexOf(b.firmware),
  );
  const [first, second] = candidates;
  return {
    firmware: first?.firmware ?? "klipper",
    ambiguous: first !== undefined && second !== undefined && first.score === second.score,
    candidates,
  };
}
