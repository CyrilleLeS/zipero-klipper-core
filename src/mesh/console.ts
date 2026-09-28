// SPDX-License-Identifier: GPL-3.0-only
import { defined } from "../invariant";
import { failure, type Issue, type ParseResult, success } from "../result";
import { type ConsoleLine, consoleLines, parseNumberRow } from "../text/console";
import { type MeshGrid, toGrid } from "./types";

/**
 * Lecture de la sortie de `BED_MESH_OUTPUT` collée depuis une console (EP-05.01).
 *
 * Format de Klipper 0.13 (klippy/extras/bed_mesh.py) :
 * - `print_probed_matrix` (via respond_info, lignes préfixées `// `) :
 *   « Mesh Leveling Probed Z positions: » puis une ligne par rangée, de l'AVANT vers l'arrière.
 * - `print_mesh` (via respond_raw, SANS préfixe) : « Mesh X,Y: », « Search Height: »,
 *   « Mesh Offsets: », « Mesh Average: », « Mesh Range: », « Interpolation Algorithm: », puis
 *   « Measured points: » = la grille INTERPOLÉE, imprimée de l'ARRIÈRE vers l'avant.
 */

export type MeshConsoleCode =
  | "mesh.none-found"
  | "mesh.incomplete"
  | "mesh.not-probed"
  | "mesh.ragged-rows"
  | "mesh.too-small"
  | "mesh.multiple-found"
  | "mesh.interpolated-mismatch";

/** Valeurs affichées par Klipper dans le bloc `print_mesh` (calculées sur la grille interpolée). */
export interface ReportedMeshInfo {
  readonly meshXCount?: number;
  readonly meshYCount?: number;
  readonly searchHeight?: number;
  readonly offsetX?: number;
  readonly offsetY?: number;
  readonly average?: number;
  readonly min?: number;
  readonly max?: number;
  readonly algorithm?: string;
}

export interface ConsoleMesh {
  /** Ligne où commence le bloc des points palpés. */
  readonly line: number;
  /** Points réellement palpés (avant → arrière, gauche → droite). */
  readonly probed: MeshGrid;
  /** Grille interpolée, remise dans l'ordre avant → arrière. */
  readonly interpolated?: MeshGrid;
  readonly reported?: ReportedMeshInfo;
}

/** Taille minimale d'un maillage Klipper (`probe_count` ≥ 3 sur chaque axe). */
const MIN_PROBE_COUNT = 3;

interface ProbedBlock {
  readonly kind: "probed";
  readonly line: number;
  readonly rows: number[][];
  readonly rowLines: number[];
}

interface InfoBlock {
  readonly kind: "info";
  readonly line: number;
  readonly info: ReportedMeshInfo;
  readonly rows: number[][];
}

type Block = ProbedBlock | InfoBlock;

const num = (value: string | undefined) => Number(value);

function readNumberRows(lines: readonly ConsoleLine[], start: number) {
  const rows: number[][] = [];
  const rowLines: number[] = [];
  let index = start;
  for (; index < lines.length; index++) {
    const current = defined(lines[index], "ligne");
    const row = parseNumberRow(current.content);
    if (!row) break;
    rows.push(row);
    rowLines.push(current.line);
  }
  return { rows, rowLines, next: index };
}

type MutableInfo = { -readonly [K in keyof ReportedMeshInfo]: ReportedMeshInfo[K] };

/** Lignes du bloc `print_mesh`, dans l'ordre où Klipper les imprime. */
const INFO_LINES: readonly (readonly [
  RegExp,
  (match: RegExpExecArray, info: MutableInfo) => void,
])[] = [
  [
    /^Mesh X,Y:\s*(\d+)\s*,\s*(\d+)/i,
    (m, info) => {
      info.meshXCount = num(m[1]);
      info.meshYCount = num(m[2]);
    },
  ],
  [
    /^Search Height:\s*([-\d.]+)/i,
    (m, info) => {
      info.searchHeight = num(m[1]);
    },
  ],
  [
    /^Mesh Offsets:\s*X=\s*([-\d.]+)\s*,\s*Y=\s*([-\d.]+)/i,
    (m, info) => {
      info.offsetX = num(m[1]);
      info.offsetY = num(m[2]);
    },
  ],
  [
    /^Mesh Average:\s*([-\d.]+)/i,
    (m, info) => {
      info.average = num(m[1]);
    },
  ],
  [
    /^Mesh Range:\s*min=\s*([-\d.]+)\s*max=\s*([-\d.]+)/i,
    (m, info) => {
      info.min = num(m[1]);
      info.max = num(m[2]);
    },
  ],
  [
    /^Interpolation Algorithm:\s*(\S+)/i,
    (m, info) => {
      info.algorithm = String(m[1]);
    },
  ],
];

function readInfoBlock(lines: readonly ConsoleLine[], start: number) {
  const info: MutableInfo = {};
  let rows: number[][] = [];
  let index = start;
  for (; index < lines.length; index++) {
    const { content } = defined(lines[index], "ligne");
    // Un second « Mesh X,Y » ouvre un autre bloc : on s'arrête avant.
    if (index > start && /^Mesh X,Y:/i.test(content)) break;
    if (/^Measured points:/i.test(content)) {
      const read = readNumberRows(lines, index + 1);
      rows = read.rows;
      index = read.next;
      break;
    }
    const known = INFO_LINES.find(([pattern]) => pattern.test(content));
    if (!known) break;
    const [pattern, apply] = known;
    apply(defined(pattern.exec(content) ?? undefined, "correspondance"), info);
  }
  return { info: info as ReportedMeshInfo, rows, next: index };
}

function scan(lines: readonly ConsoleLine[]): { blocks: Block[]; notProbedLine?: number } {
  const blocks: Block[] = [];
  let notProbedLine: number | undefined;
  let index = 0;
  while (index < lines.length) {
    const current = defined(lines[index], "ligne");
    const { content } = current;
    if (/^Mesh Leveling Probed Z positions:/i.test(content)) {
      const read = readNumberRows(lines, index + 1);
      blocks.push({
        kind: "probed",
        line: current.line,
        rows: read.rows,
        rowLines: read.rowLines,
      });
      index = read.next;
    } else if (/^Mesh X,Y:/i.test(content)) {
      const read = readInfoBlock(lines, index);
      blocks.push({ kind: "info", line: current.line, info: read.info, rows: read.rows });
      index = Math.max(read.next, index + 1);
    } else {
      if (/^(?:Bed has not been probed|bed_mesh: bed has not been probed)/i.test(content)) {
        notProbedLine ??= current.line;
      }
      index++;
    }
  }
  return notProbedLine === undefined ? { blocks } : { blocks, notProbedLine };
}

/** Une grille interpolée est cohérente avec la grille palpée si `count = (n - 1) × (pps + 1) + 1`. */
function isConsistent(probed: MeshGrid, info: ReportedMeshInfo): boolean {
  const fits = (count: number | undefined, n: number) =>
    count !== undefined && count >= n && (count - 1) % (n - 1) === 0;
  return fits(info.meshXCount, probed.cols) && fits(info.meshYCount, probed.rows);
}

export function parseBedMeshOutput(source: string): ParseResult<ConsoleMesh[], MeshConsoleCode> {
  const { blocks, notProbedLine } = scan(consoleLines(source));
  const warnings: Issue<MeshConsoleCode>[] = [];
  const meshes: ConsoleMesh[] = [];
  const used = new Set<number>();

  for (const [position, block] of blocks.entries()) {
    if (block.kind !== "probed") continue;
    // En-tête sans aucune rangée : collage tronqué.
    if (block.rows.length === 0) return failure({ code: "mesh.incomplete", line: block.line });
    const probed = toGrid(block.rows);
    if (!probed) {
      const width = defined(block.rows[0], "première rangée").length;
      const bad = block.rows.findIndex((row) => row.length !== width);
      return failure({ code: "mesh.ragged-rows", line: defined(block.rowLines[bad], "ligne") });
    }
    if (probed.rows < MIN_PROBE_COUNT || probed.cols < MIN_PROBE_COUNT) {
      return failure({
        code: "mesh.too-small",
        line: block.line,
        params: { rows: probed.rows, cols: probed.cols },
      });
    }

    // Bloc d'informations voisin (après, sinon avant : certaines consoles inversent l'ordre).
    let mesh: ConsoleMesh = { line: block.line, probed };
    for (const neighbour of [position + 1, position - 1]) {
      const candidate = blocks[neighbour];
      if (candidate?.kind !== "info" || used.has(neighbour)) continue;
      if (!isConsistent(probed, candidate.info)) continue;
      used.add(neighbour);
      const interpolated = toGrid([...candidate.rows].reverse());
      const matches =
        interpolated?.rows === candidate.info.meshYCount &&
        interpolated?.cols === candidate.info.meshXCount;
      if (interpolated && !matches) {
        warnings.push({ code: "mesh.interpolated-mismatch", line: candidate.line });
      }
      mesh = {
        ...mesh,
        reported: candidate.info,
        ...(interpolated && matches ? { interpolated } : {}),
      };
      break;
    }
    meshes.push(mesh);
  }

  if (meshes.length === 0) {
    return notProbedLine === undefined
      ? failure({ code: "mesh.none-found" })
      : failure({ code: "mesh.not-probed", line: notProbedLine });
  }
  if (meshes.length > 1)
    warnings.push({ code: "mesh.multiple-found", params: { count: meshes.length } });
  return success(meshes, warnings);
}
