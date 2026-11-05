// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from "vitest";
import { looksLikeMeshCsv, looksLikeMeshJson, parseBedMeshCsv, parseBedMeshJson } from "./import";
import { analyzeBedMesh } from "./report";

const PROBED = [
  [0.01, 0.02, 0.03],
  [0.04, 0.05, 0.06],
  [0.07, 0.08, 0.1],
];
const COLD = [
  [0.0, 0.0, 0.0],
  [0.01, 0.02, 0.01],
  [0.0, 0.01, 0.0],
];
/** `mesh_params` comme `PROFILE_OPTIONS` de bed_mesh.py. */
const PARAMS = {
  min_x: 10,
  max_x: 210,
  min_y: 20,
  max_y: 220,
  x_count: 3,
  y_count: 3,
  mesh_x_pps: 2,
  mesh_y_pps: 2,
  algo: "lagrange",
  tension: 0.2,
};
const INTERPOLATED = Array.from({ length: 7 }, (_, y) =>
  Array.from({ length: 7 }, (_, x) => 0.01 * (x + y)),
);

/** Réponse de Moonraker à `printer.objects.query?bed_mesh` (objet `get_status`). */
const MOONRAKER = JSON.stringify({
  result: {
    eventtime: 12345.6,
    status: {
      bed_mesh: {
        profile_name: "default",
        mesh_min: [10, 20],
        mesh_max: [210, 220],
        probed_matrix: PROBED,
        mesh_matrix: INTERPOLATED,
        profiles: {
          default: { points: PROBED, mesh_params: PARAMS },
          froid: { points: COLD, mesh_params: { ...PARAMS, algo: "bicubic" } },
        },
      },
    },
  },
});

describe("import JSON du maillage (EP-05.03, formats de bed_mesh.py)", () => {
  it("objet bed_mesh de Moonraker : maillage actif et profils, sans doublon", () => {
    expect(looksLikeMeshJson(MOONRAKER)).toBe(true);
    const result = parseBedMeshJson(MOONRAKER);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((m) => m.name)).toEqual(["default", "froid"]);
    const [active, cold] = result.value;
    expect(active).toMatchObject({
      line: 1,
      probed: { rows: 3, cols: 3, values: PROBED },
      geometry: { minX: 10, maxX: 210, minY: 20, maxY: 220 },
      interpolation: { xPps: 2, yPps: 2, algorithm: "lagrange", tension: 0.2 },
      printed: { algorithm: "lagrange", grid: { rows: 7, cols: 7 } },
    });
    expect(cold).toMatchObject({ line: 2, interpolation: { algorithm: "bicubic" } });
    expect(cold?.printed).toBeUndefined();
  });

  it("maillage actif sans profil connu : emprise lue, grille de Klipper écartée (algorithme inconnu)", () => {
    const json = JSON.stringify({
      profile_name: "adaptive-7f3a",
      mesh_min: [50, 60],
      mesh_max: [150, 160],
      probed_matrix: PROBED,
      mesh_matrix: INTERPOLATED,
      profiles: {},
    });
    const result = parseBedMeshJson(json);
    expect(result.ok && result.value).toEqual([
      {
        name: "adaptive-7f3a",
        line: 1,
        probed: { rows: 3, cols: 3, values: PROBED },
        geometry: { minX: 50, maxX: 150, minY: 60, maxY: 160 },
      },
    ]);
  });

  it("bed_mesh/dump_mesh : current_mesh avec ses mesh_params", () => {
    const json = JSON.stringify({
      result: {
        current_mesh: {
          name: "chaud",
          probed_matrix: PROBED,
          mesh_matrix: INTERPOLATED,
          mesh_params: { ...PARAMS, algo: "bicubic", mesh_x_pps: 2, mesh_y_pps: 2 },
        },
        profiles: {},
      },
    });
    const result = parseBedMeshJson(json);
    expect(result.ok && result.value[0]).toMatchObject({
      name: "chaud",
      geometry: { minX: 10, maxX: 210 },
      printed: { algorithm: "bicubic" },
    });
  });

  it("sortie de BED_MESH_MAP collée depuis la console", () => {
    const text = `// mesh_map_output ${JSON.stringify({ mesh_min: [10, 20], mesh_max: [210, 220], z_positions: PROBED })}`;
    expect(looksLikeMeshJson(text)).toBe(true);
    const result = parseBedMeshJson(text);
    expect(result.ok && result.value[0]).toMatchObject({
      probed: { values: PROBED },
      geometry: { minX: 10, maxY: 220 },
    });
  });

  it("refus expliqués : JSON illisible, aucun maillage, grille irrégulière, trop petite, texte", () => {
    const code = (text: string) => {
      const result = parseBedMeshJson(text);
      return result.ok ? null : result.error.code;
    };
    expect(code("{ pas du json")).toBe("import.invalid-json");
    expect(code(JSON.stringify({ foo: 1 }))).toBe("import.no-mesh");
    // Aucun maillage chargé : Klipper renvoie [[]].
    expect(code(JSON.stringify({ probed_matrix: [[]], profiles: {} }))).toBe("import.no-mesh");
    expect(
      code(
        JSON.stringify({
          probed_matrix: [
            [1, 2, 3],
            [1, 2],
            [1, 2, 3],
          ],
        }),
      ),
    ).toBe("import.ragged-rows");
    expect(
      code(
        JSON.stringify({
          probed_matrix: [
            [1, 2],
            [3, 4],
          ],
        }),
      ),
    ).toBe("import.too-small");
    expect(
      code(
        JSON.stringify({
          probed_matrix: [
            [1, "a", 3],
            [1, 2, 3],
            [1, 2, 3],
          ],
        }),
      ),
    ).toBe("import.not-numeric");
    expect(code(JSON.stringify({ probed_matrix: [1, 2, 3] }))).toBe("import.not-numeric");
  });

  it("un profil illisible n'empêche pas les autres : signalé en remarque", () => {
    const json = JSON.stringify({
      profiles: {
        bon: { points: PROBED, mesh_params: PARAMS },
        abime: { points: [[1, 2]], mesh_params: PARAMS },
      },
    });
    const result = parseBedMeshJson(json);
    expect(result.ok && result.value.map((m) => m.name)).toEqual(["bon"]);
    expect(result.warnings).toEqual([{ code: "import.too-small" }]);
  });
});

describe("import CSV du maillage (ordre de Klipper : avant → arrière, gauche → droite)", () => {
  it("virgules, point décimal", () => {
    const csv = "0.01,0.02,0.03\n0.04,0.05,0.06\n0.07,0.08,0.10\n";
    expect(looksLikeMeshCsv(csv)).toBe(true);
    expect(parseBedMeshCsv(csv)).toEqual({
      ok: true,
      value: [{ line: 1, probed: { rows: 3, cols: 3, values: PROBED } }],
      warnings: [],
    });
  });

  it("points-virgules ou tabulations : virgule décimale acceptée ; lignes vides ignorées", () => {
    const semicolon = "\n0,01;0,02;0,03\r\n0,04;0,05;0,06\r\n0,07;0,08;0,1\r\n";
    const result = parseBedMeshCsv(semicolon);
    expect(result.ok && result.value[0]).toEqual({
      line: 2,
      probed: { rows: 3, cols: 3, values: PROBED },
    });
    const tabs = "0.01\t0.02\t0.03\n0.04\t0.05\t0.06\n0.07\t0.08\t0.1";
    expect(parseBedMeshCsv(tabs).ok).toBe(true);
  });

  it("refus : texte, rangées irrégulières, maillage trop petit", () => {
    expect(looksLikeMeshCsv("Mesh Leveling Probed Z positions:\n0 0 0")).toBe(false);
    expect(looksLikeMeshCsv("[printer]\nkinematics: cartesian")).toBe(false);
    expect(parseBedMeshCsv("1,2,3\n1,x,3\n1,2,3")).toMatchObject({
      ok: false,
      error: { code: "import.not-numeric", line: 2 },
    });
    expect(parseBedMeshCsv("1,2,3\n1,2\n1,2,3")).toMatchObject({
      ok: false,
      error: { code: "import.ragged-rows", line: 1 },
    });
    expect(parseBedMeshCsv("1,2\n3,4")).toMatchObject({
      ok: false,
      error: { code: "import.too-small" },
    });
    expect(parseBedMeshCsv("\n\n")).toMatchObject({ ok: false, error: { code: "import.no-mesh" } });
  });
});

describe("analyse d'un maillage importé", () => {
  it("JSON : rapport « json », emprise et interpolation de Klipper reprises", () => {
    const result = analyzeBedMesh(MOONRAKER);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.input).toBe("json");
    expect(result.value.meshes).toHaveLength(2);
    expect(result.value.meshes[0]).toMatchObject({
      name: "default",
      geometry: { minX: 10, maxX: 210 },
      interpolated: { algorithm: "lagrange", source: "klipper" },
    });
    expect(result.value.meshes[1]?.interpolated).toMatchObject({
      algorithm: "lagrange",
      source: "computed",
    });
  });

  it("CSV : rapport « csv », sans emprise", () => {
    const result = analyzeBedMesh("0.01;0.02;0.03\n0.04;0.05;0.06\n0.07;0.08;0.1");
    expect(result.ok && result.value.input).toBe("csv");
    expect(result.ok && result.value.meshes[0]?.geometry).toBeUndefined();
  });
});
