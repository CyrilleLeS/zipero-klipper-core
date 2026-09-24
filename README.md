# zipero-klipper-core

Cœur d'analyse de [Zipero](https://zipero.fr), l'assistant de diagnostic **Klipper** :
parseurs et règles de diagnostic (maillage de plateau, `printer.cfg`, macros Jinja2, `klippy.log`,
G-code), écrits en TypeScript pur, sans DOM, exécutables dans Node.js comme dans un Web Worker.

> Ce dépôt est un **miroir en lecture seule**, synchronisé automatiquement depuis le monorepo
> de Zipero. Les signalements (bugs, faux positifs de diagnostic) sont bienvenus dans les
> *issues* ; les correctifs sont intégrés en amont puis republiés ici.

## Utilisation

```sh
npm ci
npx tsc --noEmit      # vérification des types
npx vitest run        # tests
```

Prérequis : Node.js 24 LTS ou plus récent.

## Licence

**GPL-3.0-only** — voir [`LICENSE`](./LICENSE). Klipper est un projet indépendant, sous licence
GPLv3 ; ce paquet s'appuie sur sa documentation publique et n'est ni affilié ni approuvé par
le projet Klipper.
