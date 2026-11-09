// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from "vitest";
import readme from "../README.md?raw";
import { computeMeshMetrics, parseBedMeshOutput } from "./index";

/**
 * L'exemple du README (EP-22.04) s'exécute tel quel : le premier bloc de code TypeScript, sans
 * sa ligne d'import, avec les fonctions du paquet et une console qui garde ce qu'elle reçoit.
 * README lu par l'import de texte brut de Vite (`?raw`) : aucun type de Node dans ce paquet.
 */
function example(): string {
  const block = /```ts\n([\s\S]*?)```/.exec(readme)?.[1];
  if (!block) throw new Error("README : aucun bloc ts");
  return block;
}

describe("exemple du README", () => {
  it("importe seulement des fonctions exportées par le paquet", () => {
    expect(example()).toMatch(
      /^import \{ computeMeshMetrics, parseBedMeshOutput \} from "\.\/src\/index\.ts";\n/,
    );
  });

  it("affiche le résultat annoncé en commentaire", () => {
    const body = example().replace(/^import .*\n/, "");
    const printed: string[] = [];
    const run = new Function("computeMeshMetrics", "parseBedMeshOutput", "console", body);
    run(computeMeshMetrics, parseBedMeshOutput, { log: (line: string) => printed.push(line) });
    const announced = /console\.log\(.*\); \/\/ (.+)$/m.exec(body)?.[1];
    expect(printed).toEqual(["Écart total : 0.115 mm"]);
    expect(printed).toEqual([announced]);
  });
});
