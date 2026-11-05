// SPDX-License-Identifier: GPL-3.0-only

import { ANALYSIS_LIMITS } from "../limits";
import { failure, type Issue, type ParseResult, success } from "../result";
import type { InterpolationParams } from "./interpolate";
import { type MeshGeometry, type MeshGrid, toGrid } from "./types";

/**
 * Import d'un maillage en JSON ou en CSV (EP-05.03). Formats relevés dans
 * `klippy/extras/bed_mesh.py` (Klipper, commit 214fdb2877) :
 * - objet `bed_mesh` (`get_status`, lu par Moonraker : `printer.objects.query?bed_mesh`, réponse
 *   `{"result": {"status": {"bed_mesh": …}}}`) : `profile_name`, `mesh_min`, `mesh_max` (X, Y),
 *   `probed_matrix`, `mesh_matrix` et `profiles` ({nom: {points, mesh_params}}) ;
 * - `bed_mesh/dump_mesh` : `current_mesh` ({name, probed_matrix, mesh_matrix, mesh_params}) et
 *   `profiles` ;
 * - `BED_MESH_MAP` : `mesh_map_output {"mesh_min", "mesh_max", "z_positions"}`.
 * `mesh_params` : `min_x`, `max_x`, `min_y`, `max_y`, `x_count`, `y_count`, `mesh_x_pps`,
 * `mesh_y_pps`, `algo`, `tension` (`PROFILE_OPTIONS`). Les matrices vont de l'avant (Y min) vers
 * l'arrière, chaque rangée de la gauche (X min) vers la droite ; seule la console inverse la
 * grille interpolée à l'affichage.
 * CSV (choix du porteur du projet, 05/11/2026) : même ordre que Klipper, une rangée par ligne,
 * séparateur virgule, point-virgule ou tabulation ; avec le point-virgule ou la tabulation, la
 * virgule décimale est acceptée.
 */

export const MESH_IMPORT_CODES = [
  "import.invalid-json",
  "import.no-mesh",
  "import.not-numeric",
  "import.ragged-rows",
  "import.too-small",
  "import.too-large",
] as const;
export type MeshImportCode = (typeof MESH_IMPORT_CODES)[number];

export interface ImportedMesh {
  /** Nom du profil (`default`, `adaptive-…`), s'il est connu. */
  readonly name?: string;
  /** Rang du maillage (JSON) ou ligne de la première rangée (CSV), à partir de 1. */
  readonly line: number;
  readonly probed: MeshGrid;
  readonly geometry?: MeshGeometry;
  readonly interpolation?: InterpolationParams;
  /** Grille interpolée par Klipper (`mesh_matrix`), quand son algorithme est connu. */
  readonly printed?: { readonly grid: MeshGrid; readonly algorithm: string };
}

/** Taille minimale d'un maillage Klipper (`probe_count` ≥ 3 sur chaque axe). */
const MIN_COUNT = 3;

type Json = unknown;
const isObject = (value: Json): value is Record<string, Json> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: Json): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** Grille numérique rectangulaire ; null si vide, irrégulière ou non numérique. */
type GridCheck = { grid: MeshGrid } | { code: MeshImportCode } | null;
function readMatrix(value: Json): GridCheck {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every((row) => Array.isArray(row))) return { code: "import.not-numeric" };
  const rows = value as Json[][];
  if (rows.every((row) => row.length === 0)) return null;
  if (!rows.every((row) => row.every(finite))) return { code: "import.not-numeric" };
  return checkedGrid(rows as number[][]);
}

function checkedGrid(rows: number[][]): { grid: MeshGrid } | { code: MeshImportCode } {
  const grid = toGrid(rows);
  if (!grid) return { code: "import.ragged-rows" };
  if (grid.rows < MIN_COUNT || grid.cols < MIN_COUNT) return { code: "import.too-small" };
  if (grid.rows * grid.cols > ANALYSIS_LIMITS.maxProbePoints) return { code: "import.too-large" };
  return { grid };
}

function readPair(value: Json): [number, number] | null {
  return Array.isArray(value) && value.length === 2 && finite(value[0]) && finite(value[1])
    ? [value[0], value[1]]
    : null;
}

function geometryOf(min: [number, number] | null, max: [number, number] | null) {
  if (!min || !max || min[0] >= max[0] || min[1] >= max[1]) return undefined;
  return { minX: min[0], maxX: max[0], minY: min[1], maxY: max[1] };
}

interface Params {
  readonly geometry?: MeshGeometry;
  readonly interpolation?: InterpolationParams;
  readonly algorithm?: string;
}

/** `mesh_params` de Klipper ; champs absents ou invalides ignorés un à un. */
function readParams(value: Json): Params {
  if (!isObject(value)) return {};
  const geometry = geometryOf(
    finite(value["min_x"]) && finite(value["min_y"]) ? [value["min_x"], value["min_y"]] : null,
    finite(value["max_x"]) && finite(value["max_y"]) ? [value["max_x"], value["max_y"]] : null,
  );
  const algorithm = typeof value["algo"] === "string" ? value["algo"] : undefined;
  const interpolation =
    algorithm !== undefined &&
    Number.isInteger(value["mesh_x_pps"]) &&
    Number.isInteger(value["mesh_y_pps"]) &&
    finite(value["tension"])
      ? {
          xPps: value["mesh_x_pps"] as number,
          yPps: value["mesh_y_pps"] as number,
          algorithm,
          tension: value["tension"],
        }
      : undefined;
  return {
    ...(geometry ? { geometry } : {}),
    ...(interpolation ? { interpolation } : {}),
    ...(algorithm !== undefined ? { algorithm } : {}),
  };
}

const sameGrid = (a: MeshGrid, b: MeshGrid) =>
  a.rows === b.rows &&
  a.cols === b.cols &&
  a.values.every((row, y) => row.every((z, x) => z === b.values[y]?.[x]));

/** Texte JSON : l'objet, éventuellement après `mesh_map_output` (sortie de BED_MESH_MAP). */
function parseJson(text: string): Json | undefined {
  const marker = text.indexOf("mesh_map_output");
  const start = marker >= 0 ? text.indexOf("{", marker) : text.indexOf("{");
  if (start < 0) return undefined;
  const end = text.lastIndexOf("}");
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/** true si le texte se présente comme du JSON (objet) ou une sortie de BED_MESH_MAP. */
export function looksLikeMeshJson(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("{") || /mesh_map_output\s*\{/.test(text);
}

export function parseBedMeshJson(text: string): ParseResult<ImportedMesh[], MeshImportCode> {
  const parsed = parseJson(text);
  if (!isObject(parsed)) return failure({ code: "import.invalid-json" });
  let root: Record<string, Json> = parsed;
  // Enveloppes de Moonraker : {"result": {"status": {"bed_mesh": …}}} ou {"result": …}.
  for (const key of ["result", "status", "bed_mesh"]) {
    const inner = root[key];
    if (isObject(inner)) root = inner;
  }

  const meshes: ImportedMesh[] = [];
  const warnings: Issue<MeshImportCode>[] = [];
  let firstError: MeshImportCode | null = null;
  const add = (
    check: GridCheck,
    mesh: Omit<ImportedMesh, "probed" | "line">,
    printed?: Json,
  ): MeshGrid | null => {
    if (!check) return null;
    if ("code" in check) {
      firstError ??= check.code;
      return null;
    }
    const algorithm = mesh.interpolation?.algorithm;
    const printedGrid = algorithm !== undefined ? readMatrix(printed) : null;
    meshes.push({
      ...mesh,
      line: meshes.length + 1,
      probed: check.grid,
      ...(printedGrid && "grid" in printedGrid && algorithm !== undefined
        ? { printed: { grid: printedGrid.grid, algorithm } }
        : {}),
    });
    return check.grid;
  };

  const profiles = isObject(root["profiles"]) ? root["profiles"] : {};
  const profileParams = (name: string) =>
    readParams((profiles[name] as Record<string, Json>)?.["mesh_params"]);

  // Maillage actif : `current_mesh` (dump_mesh), ou l'objet bed_mesh lui-même.
  const current = isObject(root["current_mesh"]) ? root["current_mesh"] : root;
  const currentName =
    typeof current["name"] === "string"
      ? current["name"]
      : typeof current["profile_name"] === "string"
        ? current["profile_name"]
        : undefined;
  const currentParams = isObject(current["mesh_params"])
    ? readParams(current["mesh_params"])
    : currentName
      ? profileParams(currentName)
      : {};
  const currentGeometry =
    currentParams.geometry ??
    geometryOf(readPair(current["mesh_min"]), readPair(current["mesh_max"]));
  const currentGrid = add(
    readMatrix(current["probed_matrix"] ?? current["z_positions"]),
    {
      ...(currentName ? { name: currentName } : {}),
      ...(currentGeometry ? { geometry: currentGeometry } : {}),
      ...(currentParams.interpolation ? { interpolation: currentParams.interpolation } : {}),
    },
    current["mesh_matrix"],
  );

  // Profils enregistrés ; celui déjà chargé comme maillage actif n'est pas répété.
  for (const [name, profile] of Object.entries(profiles)) {
    if (!isObject(profile)) continue;
    const check = readMatrix(profile["points"]);
    if (currentGrid && name === currentName && check && "grid" in check) {
      if (sameGrid(check.grid, currentGrid)) continue;
    }
    const params = readParams(profile["mesh_params"]);
    add(check, {
      name,
      ...(params.geometry ? { geometry: params.geometry } : {}),
      ...(params.interpolation ? { interpolation: params.interpolation } : {}),
    });
  }

  if (meshes.length === 0) return failure({ code: firstError ?? "import.no-mesh" });
  if (firstError) warnings.push({ code: firstError });
  return success(meshes, warnings);
}

/** Une ligne de CSV : séparateur et virgule décimale selon la ligne. */
function csvCells(line: string): string[] {
  if (line.includes(";") || line.includes("\t")) {
    return line.split(/[;\t]/).map((cell) => cell.trim().replace(",", "."));
  }
  return line.split(",").map((cell) => cell.trim());
}

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** true si chaque ligne non vide n'est faite que de nombres séparés (au moins deux colonnes). */
export function looksLikeMeshCsv(text: string): boolean {
  const lines = text.split(/\r\n|\r|\n/).filter((line) => line.trim() !== "");
  return (
    lines.length > 0 &&
    lines.every((line) => {
      const cells = csvCells(line).filter((cell) => cell !== "");
      return cells.length >= 2 && cells.every((cell) => NUMBER.test(cell));
    })
  );
}

export function parseBedMeshCsv(text: string): ParseResult<ImportedMesh[], MeshImportCode> {
  const rows: number[][] = [];
  let first = 0;
  for (const [index, line] of text.split(/\r\n|\r|\n/).entries()) {
    if (line.trim() === "") continue;
    const cells = csvCells(line).filter((cell) => cell !== "");
    if (!cells.every((cell) => NUMBER.test(cell))) {
      return failure({ code: "import.not-numeric", line: index + 1 });
    }
    if (rows.length === 0) first = index + 1;
    rows.push(cells.map(Number));
  }
  if (rows.length === 0) return failure({ code: "import.no-mesh" });
  const check = checkedGrid(rows);
  if ("code" in check) return failure({ code: check.code, line: first });
  return success([{ line: first, probed: check.grid }]);
}
