// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from "vitest";
import { parseBedMeshOutput } from "./console";
import { densify, printMesh, printProbedMatrix } from "./klipper-format.fixture";

// Plateau 3×3 incliné : l'arrière (dernière ligne) est plus haut que l'avant.
const probed = [
  [-0.05, -0.0425, -0.035],
  [0.0, 0.0075, 0.015],
  [0.05, 0.0575, 0.065],
];
const interpolated = densify(probed, 1); // 5×5
const bedMeshOutput = `${printProbedMatrix(probed)}\n${printMesh({ mesh: interpolated, searchHeight: 5 })}`;

describe("parseBedMeshOutput — sortie fidèle de Klipper 0.13", () => {
  it("lit la grille palpée dans l'ordre avant → arrière", () => {
    const result = parseBedMeshOutput(bedMeshOutput);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toEqual([]);
    const [mesh] = result.value;
    expect(mesh?.line).toBe(1);
    expect(mesh?.probed).toEqual({ rows: 3, cols: 3, values: probed });
  });

  it("remet la grille interpolée à l'endroit (Klipper l'imprime de l'arrière vers l'avant)", () => {
    const result = parseBedMeshOutput(bedMeshOutput);
    if (!result.ok) throw new Error("échec inattendu");
    expect(result.value[0]?.interpolated).toEqual({ rows: 5, cols: 5, values: interpolated });
  });

  it("récupère les informations affichées par Klipper", () => {
    const result = parseBedMeshOutput(bedMeshOutput);
    if (!result.ok) throw new Error("échec inattendu");
    expect(result.value[0]?.reported).toEqual({
      meshXCount: 5,
      meshYCount: 5,
      searchHeight: 5,
      offsetX: 0,
      offsetY: 0,
      average: 0.01,
      min: -0.05,
      max: 0.065,
      algorithm: "lagrange",
    });
  });
});

describe("parseBedMeshOutput — collages réels", () => {
  it("tolère les horodatages et préfixes de Mainsail / Fluidd / OctoPrint", () => {
    const pasted = [
      "14:02:11 BED_MESH_OUTPUT",
      "14:02:11 // Mesh Leveling Probed Z positions:",
      "14:02:11 // -0.057500 -0.030000 0.012500",
      "[14:02:11] // -0.022500 0.000000 0.027500",
      "Recv: // 0.005000 0.035000 0.070000",
      "14:02:11 Mesh X,Y: 3,3",
      "Mesh Offsets: X=0.0000, Y=0.0000",
    ].join("\n");
    const result = parseBedMeshOutput(pasted);
    if (!result.ok) throw new Error("échec inattendu");
    expect(result.value[0]?.probed.values).toEqual([
      [-0.0575, -0.03, 0.0125],
      [-0.0225, 0, 0.0275],
      [0.005, 0.035, 0.07],
    ]);
    expect(result.value[0]?.reported?.meshXCount).toBe(3);
    expect(result.value[0]?.interpolated).toBeUndefined();
  });

  it("associe le bon bloc même si la console affiche les messages du plus récent au plus ancien", () => {
    const reversed = `${printMesh({ mesh: interpolated })}\n${printProbedMatrix(probed)}`;
    const result = parseBedMeshOutput(reversed);
    if (!result.ok) throw new Error("échec inattendu");
    expect(result.value[0]?.interpolated?.values).toEqual(interpolated);
  });

  it("accepte la grille palpée seule", () => {
    const result = parseBedMeshOutput(printProbedMatrix(probed));
    if (!result.ok) throw new Error("échec inattendu");
    expect(result.value[0]?.reported).toBeUndefined();
  });

  it("signale plusieurs maillages collés à la suite", () => {
    const twice = `${bedMeshOutput}\n${printProbedMatrix(probed)}`;
    const result = parseBedMeshOutput(twice);
    if (!result.ok) throw new Error("échec inattendu");
    expect(result.value).toHaveLength(2);
    expect(result.warnings).toEqual([{ code: "mesh.multiple-found", params: { count: 2 } }]);
  });

  it("n'associe pas un bloc d'informations incohérent avec la grille palpée", () => {
    const other = `${printProbedMatrix(probed)}\n${printMesh({ mesh: densify([...probed, [0, 0, 0]], 0) })}`;
    const result = parseBedMeshOutput(other);
    if (!result.ok) throw new Error("échec inattendu");
    expect(result.value[0]?.reported).toBeUndefined();
  });

  it("signale une grille interpolée tronquée sans la conserver", () => {
    const truncated = bedMeshOutput.trimEnd().split("\n").slice(0, -1).join("\n");
    const result = parseBedMeshOutput(truncated);
    if (!result.ok) throw new Error("échec inattendu");
    expect(result.value[0]?.interpolated).toBeUndefined();
    expect(result.warnings.map((w) => w.code)).toEqual(["mesh.interpolated-mismatch"]);
  });
});

describe("parseBedMeshOutput — erreurs", () => {
  it("aucun maillage dans le texte", () => {
    expect(parseBedMeshOutput("bonjour")).toEqual({
      ok: false,
      error: { code: "mesh.none-found" },
      warnings: [],
    });
  });

  it("imprimante non palpée", () => {
    const result = parseBedMeshOutput("// Bed has not been probed");
    expect(result.ok ? null : result.error).toEqual({ code: "mesh.not-probed", line: 1 });
  });

  it("en-tête sans aucune rangée (collage tronqué)", () => {
    const result = parseBedMeshOutput("12:00 // Mesh Leveling Probed Z positions:\n12:00 ok");
    expect(result.ok ? null : result.error).toEqual({ code: "mesh.incomplete", line: 1 });
  });

  it("rangées de longueurs différentes (collage incomplet)", () => {
    const ragged =
      "// Mesh Leveling Probed Z positions:\n// 0.1 0.2 0.3\n// 0.1 0.2\n// 0.1 0.2 0.3";
    const result = parseBedMeshOutput(ragged);
    expect(result.ok ? null : result.error).toEqual({ code: "mesh.ragged-rows", line: 3 });
  });

  it("grille trop petite pour un maillage Klipper", () => {
    const small = "// Mesh Leveling Probed Z positions:\n// 0.1 0.2 0.3\n// 0.1 0.2 0.3";
    const result = parseBedMeshOutput(small);
    expect(result.ok ? null : result.error).toEqual({
      code: "mesh.too-small",
      line: 1,
      params: { rows: 2, cols: 3 },
    });
  });
});
