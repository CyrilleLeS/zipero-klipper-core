// SPDX-License-Identifier: GPL-3.0-only

/**
 * Découpage d'un `klippy.log` en sessions (EP-07.02), ligne par ligne : un journal de 200 Mo est
 * lu en flux, sans être gardé en mémoire (seuls le résumé et la configuration de chaque session le
 * sont). Lignes relevées dans le code de Klipper (klippy.py, mcu.py, configfile.py,
 * queuelogger.py ; messages sans horodatage) :
 * - démarrage du processus : `Starting Klippy...`, puis `Git version: '…'`, `Branch:`, `CPU:`,
 *   `Device:`, `Linux:`, `Python: '…'` ;
 * - chaque démarrage de l'imprimante (RESTART compris) : `Start printer at <date> (<heure Unix>
 *   <horloge monotone>)` — frontière des sessions ;
 * - configuration : entre `===== Config file =====` et `=======================` ;
 * - MCU : `Loaded MCU '<nom>' <n> commands (<version> / <compilation>)` et
 *   `MCU '<nom>' config: CLÉ=valeur …` (dont `MCU=` et `CLOCK_FREQ=`) ;
 * - fin : `Restarting printer`, `Transition to shutdown state: <raison>`, `Starting Klippy...` ;
 * - échec du chargement : `Config error`, puis la pile Python dont la dernière ligne donne la cause ;
 * - rotation : `=============== Log rollover at <date> ===============`, précédée des versions et
 *   de la configuration recopiées en tête du nouveau fichier.
 */

export interface LogMcu {
  readonly name: string;
  readonly commands?: number | undefined;
  readonly version?: string | undefined;
  /** Microcontrôleur (`MCU=` de la ligne de config), ex. « stm32f446xx ». */
  readonly chip?: string | undefined;
  readonly clockFrequency?: number | undefined;
}

export interface LogShutdown {
  readonly line: number;
  readonly reason: string;
}

export interface LogSession {
  /** Ligne de début (1 = première ligne du fichier). */
  readonly startLine: number;
  readonly endLine: number;
  /** Heure de démarrage (secondes Unix), si la ligne `Start printer at` est présente. */
  readonly startedAt?: number | undefined;
  /** true : le fichier commence en cours de session (journal tourné, extrait). */
  readonly partial: boolean;
  readonly gitVersion?: string | undefined;
  readonly branch?: string | undefined;
  readonly python?: string | undefined;
  readonly cpu?: string | undefined;
  readonly device?: string | undefined;
  /** Configuration chargée, telle que Klipper l'a écrite dans le journal. */
  readonly config?: string | undefined;
  readonly configTruncated: boolean;
  readonly mcus: readonly LogMcu[];
  readonly shutdowns: readonly LogShutdown[];
  /** Cause d'un échec de chargement de la configuration (`Config error`). */
  readonly configError?: string | undefined;
  /** `restart` : RESTART ou FIRMWARE_RESTART ; `new-process` : Klipper relancé (mise à jour…). */
  readonly endedBy: "restart" | "new-process" | "end-of-file";
}

export interface LogSummary {
  readonly lines: number;
  readonly sessions: readonly LogSession[];
  /** Rotations du journal rencontrées. */
  readonly rollovers: number;
}

/** Taille maximale de la configuration gardée par session (caractères). */
const MAX_CONFIG = 2_000_000;
/** Raisons d'arrêt gardées par session. */
const MAX_SHUTDOWNS = 200;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
interface Draft extends Omit<Mutable<LogSession>, "mcus" | "shutdowns" | "config"> {
  mcus: Mutable<LogMcu>[];
  shutdowns: LogShutdown[];
  configParts?: string[];
  configLength: number;
}

/** Valeur entre apostrophes de Python (`'v0.12.0-1-g1'`) ou texte brut. */
const unquote = (value: string) => value.trim().replace(/^'(.*)'$/, "$1");

/** Lecteur incrémental : `push` pour chaque ligne, `finish` pour le résumé. */
export interface LogReader {
  push(line: string): void;
  finish(): LogSummary;
}

export function createLogReader(): LogReader {
  const sessions: LogSession[] = [];
  let lineNumber = 0;
  let rollovers = 0;
  let inConfig = false;
  let configTrace = false;
  // Informations du processus (bloc des versions), reportées sur chaque session qu'il démarre.
  let process: Pick<Draft, "gitVersion" | "branch" | "python" | "cpu" | "device"> = {};

  const open = (startLine: number, partial: boolean): Draft => ({
    startLine,
    endLine: startLine,
    partial,
    ...process,
    configTruncated: false,
    configLength: 0,
    mcus: [],
    shutdowns: [],
    endedBy: "end-of-file",
  });
  let current: Draft | undefined;

  const close = (endedBy: LogSession["endedBy"]) => {
    if (!current) return;
    const { configParts, configLength: _length, ...rest } = current;
    sessions.push({
      ...rest,
      endedBy,
      ...(configParts ? { config: configParts.join("\n") } : {}),
    });
    current = undefined;
  };

  const session = () => {
    current ??= open(lineNumber, true);
    return current;
  };

  const mcu = (name: string) => {
    const draft = session();
    let found = draft.mcus.find((m) => m.name === name);
    if (!found) {
      found = { name };
      draft.mcus.push(found);
    }
    return found;
  };

  return {
    push(raw) {
      lineNumber++;
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (current) current.endLine = lineNumber;

      // Pile d'erreur Python qui suit `Config error` : sa dernière ligne « Type: message » donne
      // la cause (« configparser.Error: Unable to open config file … »).
      if (configTrace) {
        if (/^(Traceback|During handling|\s|$)/.test(line)) return;
        const exception = /^[\w.]+(?:Error|Exception|error): (.+)$/.exec(line);
        if (exception) {
          session().configError = (exception[1] ?? "").trim().slice(0, 500);
          return;
        }
        configTrace = false;
      }
      if (inConfig) {
        if (line === "=======================") {
          inConfig = false;
          return;
        }
        const draft = session();
        if (draft.configLength + line.length + 1 > MAX_CONFIG) {
          draft.configTruncated = true;
          return;
        }
        draft.configParts?.push(line);
        draft.configLength += line.length + 1;
        return;
      }
      if (line === "===== Config file =====") {
        inConfig = true;
        // Une nouvelle copie (rotation, redémarrage) remplace la précédente.
        const draft = session();
        draft.configParts = [];
        draft.configLength = 0;
        draft.configTruncated = false;
        return;
      }

      if (line === "Starting Klippy...") {
        close("new-process");
        process = {};
        return;
      }
      if (line === "Config error") {
        configTrace = true;
        return;
      }
      if (line === "Restarting printer") {
        close("restart");
        return;
      }
      if (/^=+ Log rollover at .* =+$/.test(line)) {
        rollovers++;
        return;
      }
      const started = /^Start printer at .*\((\d+(?:\.\d+)?) [\d.]+\)\s*$/.exec(line);
      if (started) {
        close("end-of-file");
        current = { ...open(lineNumber, false), startedAt: Number(started[1]) };
        return;
      }
      const loaded = /^Loaded MCU '([^']+)' (\d+) commands \((.*?) \/ /.exec(line);
      if (loaded) {
        const found = mcu(loaded[1] ?? "mcu");
        found.commands = Number(loaded[2]);
        found.version = loaded[3];
        return;
      }
      const mcuConfig = /^MCU '([^']+)' config: (.*)$/.exec(line);
      if (mcuConfig) {
        const found = mcu(mcuConfig[1] ?? "mcu");
        const constants = mcuConfig[2] ?? "";
        const chip = /(?:^| )MCU=(\S+)/.exec(constants)?.[1];
        const clock = /(?:^| )CLOCK_FREQ=(\d+)/.exec(constants)?.[1];
        if (chip) found.chip = chip;
        if (clock) found.clockFrequency = Number(clock);
        return;
      }
      const shutdown = /^Transition to shutdown state: (.*)$/.exec(line);
      if (shutdown) {
        const draft = session();
        if (draft.shutdowns.length < MAX_SHUTDOWNS) {
          draft.shutdowns.push({ line: lineNumber, reason: (shutdown[1] ?? "").trim() });
        }
        return;
      }
      const version = /^(Git version|Branch|Python|CPU|Device): (.+)$/.exec(line);
      if (!version) return;
      const value = version[2] ?? "";
      if (version[1] === "Git version") process.gitVersion = unquote(value);
      else if (version[1] === "Branch") process.branch = value.trim();
      else if (version[1] === "Python") process.python = unquote(value).split(" ")[0];
      else if (version[1] === "CPU") process.cpu = value.trim();
      else process.device = value.trim();
      // Bloc des versions : reporté sur la session en cours (copie lors d'une rotation).
      if (current) Object.assign(current, process);
    },

    finish() {
      close("end-of-file");
      return { lines: lineNumber, sessions, rollovers };
    },
  };
}

/** Raccourci pour un texte déjà en mémoire (tests, petits journaux). */
export function readKlippyLog(text: string): LogSummary {
  const reader = createLogReader();
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) reader.push(line);
  return reader.finish();
}
