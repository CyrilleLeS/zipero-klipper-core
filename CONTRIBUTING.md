<!-- SPDX-License-Identifier: GPL-3.0-only -->

# Contribuer à zipero-klipper-core

*[English below](#english)*

Merci de votre intérêt. Ce dépôt est un **miroir** : il est publié automatiquement depuis le
dépôt de Zipero, où le code est maintenu.

## Signaler

- **Bug, faux positif ou faux négatif de diagnostic** : ouvrez une *issue* avec le fichier
  concerné (un `printer.cfg`, une sortie `BED_MESH_OUTPUT`, un extrait de `klippy.log`, du
  G-code), **sans** mots de passe, clés d'API ni adresses privées. Indiquez le firmware (Klipper,
  Kalico) et sa version, ce que vous attendiez et ce que vous avez obtenu.
- **Faille de sécurité** : jamais dans une issue, voir [`SECURITY.md`](SECURITY.md).

## Proposer un correctif

1. Ouvrez une *pull request* sur ce dépôt.
2. Si elle est acceptée, elle est **reprise dans le dépôt de Zipero** avec vous comme co-auteur
   (ligne `Co-authored-by:` du commit), puis republiée ici par le miroir. La PR est alors fermée
   avec le lien du commit : elle n'est pas fusionnée directement, sinon le miroir suivant
   échouerait.
3. En proposant une contribution, vous acceptez qu'elle soit publiée sous la licence du paquet,
   **GPL-3.0-only**.

## Règles du code

- Chaque fichier commence par `// SPDX-License-Identifier: GPL-3.0-only`.
- TypeScript pur : ni DOM, ni module de Node dans le code (le cœur tourne aussi dans un Web
  Worker).
- Le cœur ne produit **aucun texte destiné à l'utilisateur** : des codes stables et des
  paramètres, traduits par l'interface.
- Une règle s'appuie sur le comportement réel de Klipper : citez la source (fichier du code ou
  page de la documentation de Klipper) dans le code ou la PR.
- Tout nouveau comportement a son test ; une règle de diagnostic a un cas positif et un cas
  négatif.
- Avant d'envoyer : `npm test` et `npx tsc --noEmit` passent.

Messages de commit au format [Conventional Commits](https://www.conventionalcommits.org/)
(`fix: …`, `feat: …`). Français ou anglais, au choix.

---

## English

This repository is a **mirror**, published automatically from the Zipero repository where the
code is maintained.

- **Bugs, false positives or false negatives**: open an issue with the file involved (a
  `printer.cfg`, `BED_MESH_OUTPUT` output, a `klippy.log` excerpt, G-code), **without**
  passwords, API keys or private addresses. Give the firmware (Klipper, Kalico) and its version,
  what you expected and what you got.
- **Security issues**: never in an issue, see [`SECURITY.md`](SECURITY.md).
- **Patches**: open a pull request. If accepted, it is **applied in the Zipero repository** with
  you as co-author (`Co-authored-by:` commit trailer), then republished here by the mirror; the
  PR is closed with a link to the commit (merging it directly would break the next mirror). By
  contributing, you agree that your contribution is published under the package license,
  **GPL-3.0-only**.
- **Code rules**: `// SPDX-License-Identifier: GPL-3.0-only` at the top of every file; plain
  TypeScript, no DOM and no Node module in the code (the core also runs in a Web Worker); no
  user-facing text (stable codes and parameters, translated by the interface); rules follow
  Klipper's actual behavior, with the source cited (Klipper code file or documentation page);
  every new behavior has a test, every diagnostic rule a positive and a negative case;
  `npm test` and `npx tsc --noEmit` pass.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/). French or
  English, as you prefer.
