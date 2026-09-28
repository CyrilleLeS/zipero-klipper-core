// SPDX-License-Identifier: GPL-3.0-only
import { type ConfigSection, parseConfig } from "../config/ini";
import { failure, type Issue, type ParseResult, success } from "../result";
import { type MeshGrid, type MeshProfileParams, toGrid } from "./types";

/**
 * Lecture des profils de maillage sauvegardés (`[bed_mesh <nom>]`, en général dans le bloc
 * SAVE_CONFIG d'un printer.cfg) — EP-05.02. Fidèle à `BedMeshProfileManager` de Klipper 0.13 :
 * version de profil 1, options typées, `points` découpés par virgules et retours à la ligne.
 */

export type MeshProfileCode =
  | "profile.none-found"
  | "profile.unsupported-version"
  | "profile.missing-option"
  | "profile.invalid-option"
  | "profile.points-mismatch";

export interface MeshProfile {
  /** Nom du profil (`default`, `froid`…). */
  readonly name: string;
  /** Ligne de l'en-tête de section. */
  readonly line: number;
  readonly probed: MeshGrid;
  readonly params: MeshProfileParams;
  /** true si le profil vient du bloc SAVE_CONFIG. */
  readonly autosave: boolean;
}

const PROFILE_VERSION = 1;

/** Options du profil et leur type, comme `PROFILE_OPTIONS` dans bed_mesh.py. */
const OPTIONS = {
  min_x: "float",
  max_x: "float",
  min_y: "float",
  max_y: "float",
  x_count: "int",
  y_count: "int",
  mesh_x_pps: "int",
  mesh_y_pps: "int",
  algo: "str",
  tension: "float",
} as const;

type OptionName = keyof typeof OPTIONS;

function parseNumber(value: string, type: "int" | "float"): number | null {
  const pattern = type === "int" ? /^[-+]?\d+$/ : /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;
  return pattern.test(value.trim()) ? Number(value) : null;
}

function readProfile(
  section: ConfigSection,
  name: string,
): { profile: MeshProfile } | { issue: Issue<MeshProfileCode> } {
  const version = section.options.get("version");
  const versionNumber = version ? parseNumber(version.value, "int") : 0;
  if (versionNumber !== PROFILE_VERSION) {
    return {
      issue: {
        code: "profile.unsupported-version",
        line: version?.line ?? section.line,
        params: { profile: name, version: version?.value ?? "0" },
      },
    };
  }

  const values: Partial<Record<OptionName, number | string>> = {};
  for (const [option, type] of Object.entries(OPTIONS) as [
    OptionName,
    (typeof OPTIONS)[OptionName],
  ][]) {
    const entry = section.options.get(option);
    if (!entry) {
      return {
        issue: {
          code: "profile.missing-option",
          line: section.line,
          params: { profile: name, option },
        },
      };
    }
    const parsed = type === "str" ? entry.value : parseNumber(entry.value, type);
    if (parsed === null || parsed === "") {
      return {
        issue: {
          code: "profile.invalid-option",
          line: entry.line,
          params: { profile: name, option },
        },
      };
    }
    values[option] = parsed;
  }

  const pointsOption = section.options.get("points");
  if (!pointsOption) {
    return {
      issue: {
        code: "profile.missing-option",
        line: section.line,
        params: { profile: name, option: "points" },
      },
    };
  }
  const rows = pointsOption.value
    .split("\n")
    .map((row) =>
      row
        .split(",")
        .map((cell) => cell.trim())
        .filter((cell) => cell !== ""),
    )
    .filter((row) => row.length > 0)
    .map((row) => row.map((cell) => parseNumber(cell, "float")));
  const numeric = rows.every((row) => row.every((cell) => cell !== null));
  const grid = numeric ? toGrid(rows as number[][]) : null;
  const xCount = values.x_count as number;
  const yCount = values.y_count as number;
  if (!grid || grid.cols !== xCount || grid.rows !== yCount) {
    return {
      issue: {
        code: "profile.points-mismatch",
        line: pointsOption.line,
        params: { profile: name, expectedRows: yCount, expectedCols: xCount },
      },
    };
  }

  return {
    profile: {
      name,
      line: section.line,
      probed: grid,
      autosave: pointsOption.autosave,
      params: {
        minX: values.min_x as number,
        maxX: values.max_x as number,
        minY: values.min_y as number,
        maxY: values.max_y as number,
        xCount,
        yCount,
        xPps: values.mesh_x_pps as number,
        yPps: values.mesh_y_pps as number,
        algorithm: values.algo as string,
        tension: values.tension as number,
      },
    },
  };
}

export function parseMeshProfiles(source: string): ParseResult<MeshProfile[], MeshProfileCode> {
  const profiles: MeshProfile[] = [];
  const warnings: Issue<MeshProfileCode>[] = [];
  for (const section of parseConfig(source)) {
    // Comme `get_prefix_sections("bed_mesh")` : « bed_mesh <nom> », pas la section [bed_mesh].
    const match = /^bed_mesh\s+(.+)$/.exec(section.name);
    if (!match?.[1]) continue;
    const result = readProfile(section, match[1].trim());
    if ("profile" in result) profiles.push(result.profile);
    else warnings.push(result.issue);
  }
  if (profiles.length === 0) {
    const [first, ...rest] = warnings;
    return failure(first ?? { code: "profile.none-found" }, rest);
  }
  return success(profiles, warnings);
}
