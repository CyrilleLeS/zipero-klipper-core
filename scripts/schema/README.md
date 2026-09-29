# Générateur du schéma des options (ADR 0022)

Produit `src/config/schema/klipper-<commit>.json`, utilisé par `validateConfig`.

```sh
# depuis packages/klipper-core ; télécharge Klipper au commit (hors dépôt, dossier temporaire)
PYTHONUTF8=1 python scripts/schema/generate.py [commit complet]
```

- `analyze.py` : analyse statique du code de Klipper (jamais exécuté). Suit la section `config`
  de fonction en fonction, depuis les points d'entrée réels (`add_printer_objects` du cœur,
  `load_config` et `load_config_prefix` de chaque module `extras`) : lectures `get*`, bornes,
  choix, obligation (lecture sans défaut sur un chemin sans condition), sous-sections
  (`getsection`, `get_prefix_sections`), variantes par choix (`control: pid`).
- `generate.py` : points d'entrée, crochets pour les aiguillages dynamiques (cinématique chargée
  par `importlib`, capteurs de température enregistrés par `add_sensor_factory`), fusion des
  lectures (bornes les plus lâches : aucun faux positif), couche curée.
- `curated.json` : options supprimées (vérifiées dans `docs/Config_Changes.md` de Klipper à
  chaque génération) et sections ou options hors Klipper (forks, modules installés à part).
- `unresolved.txt` : appels que l'analyse n'a pas su suivre ; à relire à chaque régénération.

Contrôle : `tooling/corpus-tests/src/config-validation.test.ts` (dépôt privé) valide tout le
corpus. Aucune alerte sur les configurations officielles de Klipper ; sur les configurations
réelles, seules des alertes vérifiées à la main.
