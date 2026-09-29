// SPDX-License-Identifier: GPL-3.0-only

/**
 * Chemins des fichiers de configuration fournis (EP-06.02) : relatifs, séparateur `/`, sensibles
 * à la casse comme sous Linux (Klipper). Les jokers d'`[include]` suivent `glob.glob` de Python
 * (sans `recursive`) : `*`, `?`, `[abc]`, `[!abc]` par segment de chemin ; `*` et `?` ne
 * trouvent pas les fichiers cachés (commençant par `.`), sauf motif commençant par `.`.
 */

/** Chemin normalisé : `\` → `/`, sans `.` ni segment vide, `..` résolu quand c'est possible. */
export function normalizePath(path: string): string {
  const absolute = path.startsWith("/");
  const segments: string[] = [];
  for (const segment of path.replaceAll("\\", "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === ".." && segments.length > 0 && segments.at(-1) !== "..") segments.pop();
    else segments.push(segment);
  }
  return (absolute ? "/" : "") + segments.join("/");
}

export function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : index === 0 ? "/" : "";
}

/** `os.path.join` : un chemin absolu remplace ce qui précède. */
export function joinPath(dir: string, path: string): string {
  if (path.startsWith("/") || dir === "") return path;
  return `${dir.replace(/\/$/, "")}/${path}`;
}

/** `glob.has_magic`. */
export const hasMagic = (pattern: string) => /[*?[]/.test(pattern);

/** Traduction d'un segment de motif (`fnmatch.translate`) en expression régulière. */
function segmentRegex(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] ?? "";
    if (char === "*") source += ".*";
    else if (char === "?") source += ".";
    else if (char === "[") {
      const end = pattern.indexOf("]", i + 2);
      if (end < 0) {
        source += "\\[";
        continue;
      }
      let set = pattern.slice(i + 1, end);
      const negated = set.startsWith("!");
      if (negated) set = set.slice(1);
      source += `[${negated ? "^" : ""}${set.replace(/[\\^\]]/g, "\\$&")}]`;
      i = end;
    } else source += char.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "s");
}

function matchesSegment(pattern: string, name: string): boolean {
  if (!hasMagic(pattern)) return pattern === name;
  if (name.startsWith(".") && !pattern.startsWith(".")) return false;
  return segmentRegex(pattern).test(name);
}

/** Le fichier `path` (normalisé) est-il trouvé par le motif `pattern` ? */
export function matchesGlob(pattern: string, path: string): boolean {
  const patternSegments = normalizePath(pattern).split("/");
  const pathSegments = path.split("/");
  return (
    patternSegments.length === pathSegments.length &&
    patternSegments.every((segment, index) => matchesSegment(segment, pathSegments[index] ?? ""))
  );
}
