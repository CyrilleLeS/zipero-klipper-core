// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from "vitest";
import {
  JINJA_CODES,
  JINJA_ENVIRONMENTS,
  type JinjaEnvironment,
  jinjaEnvironment,
  lintTemplate,
} from "./jinja";
import { JINJA_CASES } from "./jinja.fixture";

const { klipper, kalico } = JINJA_ENVIRONMENTS;

/** Première erreur de démarrage, au format de l'oracle (message et ligne de Jinja). */
function verdict(template: string, env: JinjaEnvironment = klipper) {
  const issue = lintTemplate(template, env).find((i) => i.startup);
  if (!issue) return null;
  return issue.jinjaLine === undefined
    ? { python: "SyntaxError" }
    : { line: issue.jinjaLine, message: issue.message };
}

const first = (template: string, env: JinjaEnvironment = klipper) =>
  lintTemplate(template, env).find((i) => i.startup);

describe("lintTemplate : verdicts du vrai Jinja (cas limites, EP-06.07)", () => {
  it.each(JINJA_CASES.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    expect(verdict(c.template, klipper)).toEqual(c.klipper);
    expect(verdict(c.template, kalico)).toEqual(c.kalico);
  });
});

describe("lintTemplate : codes, paramètres et lignes affichées", () => {
  it("bloc non fermé : ligne de la balise ouvrante, Jinja rapportant la fin du modèle", () => {
    // Jinja rapporte la ligne où commence le dernier jeton (texte « \nG1 » après « { a } »).
    const issue = first("G28\n{% if x %}\nG1\n{% for i in y %}\n{ a }\nG1");
    expect(issue).toMatchObject({ code: "jinja.unclosed-block", line: 4, params: { tag: "for" } });
    expect(issue?.jinjaLine).toBe(5);
  });

  it.each([
    ["G28\n{% endif %}", "jinja.unexpected-tag", { tag: "endif" }],
    ["{% for x in y %}{% if x %}{% endfor %}", "jinja.unexpected-tag", { tag: "endfor" }],
    ["{% do x %}", "jinja.unknown-tag", { tag: "do" }],
    ["{ x @ y }", "jinja.unexpected-char", { char: "@" }],
    ["{ (1 }", "jinja.unbalanced", { char: "}", expected: ")" }],
    ["{ 1) }", "jinja.unbalanced", { char: ")" }],
    ["{ x|floatt }", "jinja.unknown-filter", { name: "floatt" }],
    ["{% if x is nombre %}{% endif %}", "jinja.unknown-test", { name: "nombre" }],
  ] as const)("%j → %s", (template, code, params) => {
    expect(first(template)).toMatchObject({ code, params, startup: true });
  });

  it.each([
    ["{# commentaire", "jinja.unclosed-comment"],
    ["{% raw %}x", "jinja.unclosed-raw"],
    ["M117 {", "jinja.unexpected-end"],
    ["{% if x", "jinja.unexpected-end"],
    ["{ x y }", "jinja.syntax"],
    ["{{ printer.toolhead.position.z }}", "jinja.double-brace"],
  ] as const)("%j → %s", (template, code) => {
    expect(first(template)?.code).toBe(code);
  });

  it("doubles accolades : ligne de l'accolade, message de Jinja conservé", () => {
    expect(first("G28\n{{ x }}")).toMatchObject({
      line: 2,
      message: "expected token ':', got '}'",
    });
  });

  it("caractère non imprimable : représenté comme Python", () => {
    expect(first("{ \u0001 }")?.message).toBe("unexpected char '\\x01' at 2");
    expect(first("{ ​ }")?.message).toBe("unexpected char '\\u200b' at 2");
    expect(first("{ '\\x4' }")?.message).toBe("truncated \\xXX escape");
  });

  it("modèle valide : aucune erreur", () => {
    expect(lintTemplate("{% set t = params.T|default(200)|int %}\nM104 S{t}")).toEqual([]);
    expect(lintTemplate("")).toEqual([]);
  });
});

describe("lintTemplate : Kalico (Jinja 3.1, do, break, continue)", () => {
  it("filtre inconnu dans un if : erreur à l'exécution seulement", () => {
    const issues = lintTemplate("{% if x %}\n{ y|inconnu }\n{% endif %}", kalico);
    expect(issues).toEqual([
      {
        code: "jinja.unknown-filter",
        line: 2,
        message: "No filter named 'inconnu' found.",
        startup: false,
        params: { name: "inconnu" },
      },
    ]);
  });

  it("puis l'erreur de démarrage qui suit", () => {
    const issues = lintTemplate("{ a|b if c }{ d|zz }", kalico);
    expect(issues.map((i) => [i.startup, i.params?.["name"]])).toEqual([
      [false, "b"],
      [true, "zz"],
    ]);
  });

  it("break hors boucle : erreur du code Python généré, à la ligne de la balise", () => {
    expect(first("G28\n{% break %}", kalico)).toMatchObject({
      code: "jinja.loop-control",
      line: 2,
      message: "'break' outside loop",
      params: { tag: "break" },
    });
    expect(first("{% continue %}", kalico)?.message).toBe("'continue' not properly in loop");
    expect(first("{% for x in y %}{% break %}{% endfor %}", kalico)).toBeUndefined();
  });

  it("environnement par firmware", () => {
    expect(jinjaEnvironment("kalico")).toBe(kalico);
    for (const firmware of [
      "klipper",
      "creality-k1",
      "qidi",
      "qidi-plus4",
      "sovol-sv08",
    ] as const) {
      expect(jinjaEnvironment(firmware)).toBe(klipper);
    }
  });
});

it("codes : tous distincts", () => {
  expect(new Set(JINJA_CODES).size).toBe(JINJA_CODES.length);
});
