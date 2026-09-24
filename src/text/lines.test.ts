// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from "vitest";
import { splitLines } from "./lines";

describe("splitLines", () => {
  it("retourne un tableau vide pour un texte vide", () => {
    expect(splitLines("")).toEqual([]);
  });

  it("numérote les lignes à partir de 1", () => {
    expect(splitLines("[printer]\nkinematics: cartesian")).toEqual([
      { line: 1, text: "[printer]" },
      { line: 2, text: "kinematics: cartesian" },
    ]);
  });

  it("gère indifféremment LF, CRLF et CR", () => {
    const expected = ["a", "b", "c", "d"];
    expect(splitLines("a\r\nb\nc\rd").map((l) => l.text)).toEqual(expected);
  });

  it("ignore la fin de ligne finale mais conserve les lignes vides internes", () => {
    expect(splitLines("a\n\nb\n")).toEqual([
      { line: 1, text: "a" },
      { line: 2, text: "" },
      { line: 3, text: "b" },
    ]);
  });

  it("retire le BOM UTF-8 sans décaler la numérotation", () => {
    expect(splitLines("\uFEFF[include macros.cfg]")).toEqual([
      { line: 1, text: "[include macros.cfg]" },
    ]);
  });

  it("retourne un tableau vide pour un fichier ne contenant qu'un BOM", () => {
    expect(splitLines("\uFEFF")).toEqual([]);
  });
});
