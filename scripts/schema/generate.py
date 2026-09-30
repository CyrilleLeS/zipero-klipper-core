# SPDX-License-Identifier: GPL-3.0-only
"""Génère le schéma des options de configuration d'un firmware (EP-01.10, EP-01.17, ADR 0022).

Usage (depuis packages/klipper-core) : python scripts/schema/generate.py [firmware…]
Pour chaque firmware de FIRMWARES (par défaut : tous), récupère son dossier klippy/ au commit
épinglé (hors dépôt, dans le dossier temporaire, extraction partielle git), analyse son code sans
l'exécuter (analyze.py), applique la couche curée (curated.json) et écrit
src/config/schema/<firmware>-<commit>.json. Pour suivre une nouvelle version : changer le commit
ci-dessous, régénérer, relire le diff du schéma.
"""
import ast
import configparser
import io
import json
import re
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from analyze import Analyzer, Project, UNKNOWN, string_values  # noqa: E402
from commands import command_table  # noqa: E402

HERE = Path(__file__).parent
PACKAGE = HERE.parent.parent
# Firmwares : dépôt public (GPL), commit épinglé, dossier contenant klippy/ dans le dépôt.
# Elegoo (Neptune 4) ne publie pas ses sources : pas de schéma possible (EP-01.17).
# [display_data groupe nom] : sections regroupées par nom de groupe dans un dictionnaire, puis
# confiées en liste à DisplayGroup (extras/display/display.py) ; trop indirect pour l'analyse.
DISPLAY_DATA = {"module": "extras.display.display", "function": "DisplayGroup.__init__",
                "param": "data_configs", "labels": "display_data {*}", "list": True}

FIRMWARES = {
    "klipper": {"repo": "Klipper3d/klipper", "commit": "214fdb2877ff4640e9316a663c1b8b2e232c86fd", "path": "",
                "entries": [DISPLAY_DATA]},
    "kalico": {
        "repo": "KalicoCrew/kalico", "commit": "1f791b4d74b44bd72b22c0b2528617aa96ed4959", "path": "",
        # Profils de régulation (PID, MPC) : section reçue via self.outer_instance.config, trop
        # indirect pour l'analyse ; lue par _init_profile pour chaque section de chauffage.
        "entries": [{"module": "extras.heaters", "function": "Heater.ProfileManager._init_profile",
                     "param": "config_section", "labels": "heaters"},
                    # Profils enregistrés : [pid_profile <chauffage> <nom>] (EP-06.15).
                    {"module": "extras.heaters", "function": "Heater.ProfileManager._init_profile",
                     "param": "config_section", "labels": "pid_profile {*}"},
                    DISPLAY_DATA],
        # Références ${section.option} et section [constants] (klippy/configfile.py de Kalico).
        "interpolation": True,
    },
    "creality-k1": {"repo": "CrealityOfficial/K1_Series_Klipper", "commit": "e09f36e6ada60e5467b0bef731a96263b5d8095b", "path": ""},
    "qidi": {"repo": "QIDITECH/klipper", "commit": "653d7a8f6ec4700ec02c2319888ad98a92c1a0c3", "path": ""},
    "qidi-plus4": {"repo": "QIDITECH/klipper", "commit": "4bb7c6337936ef273e621d1f55bc0ef92114785d", "path": ""},
    "sovol-sv08": {"repo": "Sovol3d/SV08", "commit": "a60644875f8c756d20b3828c9416518b414b5491", "path": "home/sovol/klipper"},
}


def fetch(firmware):
    """Dossier du firmware (contenant klippy/) : archive GitHub, ou extraction partielle git."""
    spec = FIRMWARES[firmware]
    cache = Path(tempfile.gettempdir()) / "klipper-src"
    if firmware == "klipper":
        root = cache / f"klipper-{spec['commit']}"
        if not root.exists():
            cache.mkdir(parents=True, exist_ok=True)
            data = urllib.request.urlopen(f"https://codeload.github.com/Klipper3d/klipper/tar.gz/{spec['commit']}").read()
            with tarfile.open(fileobj=io.BytesIO(data)) as archive:
                archive.extractall(cache, filter="data")
        return root
    root = cache / f"{firmware}-{spec['commit'][:10]}"
    if not (root / ".git").exists():
        root.mkdir(parents=True, exist_ok=True)
        base = f"{spec['path']}/" if spec["path"] else ""
        git = lambda *args: subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True)
        git("init", "-q")
        git("remote", "add", "origin", f"https://github.com/{spec['repo']}.git")
        git("sparse-checkout", "set", "--no-cone", f"/{base}klippy/", f"/{base}docs/")
        git("fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", spec["commit"])
        git("checkout", "-q", "FETCH_HEAD")
    return root / spec["path"] if spec["path"] else root


def label_regex(label):
    pattern = re.escape(label).replace(r"\{\*\}", ".+").replace(r"\{n\}", r"\d+").replace(r"\{n\?\}", r"\d*").replace(r"\{a\}", "[a-z]")
    return f"^{pattern}$"


# --- Crochets : aiguillages dynamiques de Klipper ---------------------------------------------

def kinematics_hook(project):
    """toolhead.py : `importlib.import_module('kinematics.' + kin_name).load_kinematics(self, config)`."""
    kinds = sorted(
        name.split(".", 1)[1] for name, module in project.modules.items()
        if name.startswith("kinematics.") and "load_kinematics" in module.functions
    )

    def hook(analyzer, label, when, conditional):
        for kind in kinds:
            module = project.modules[f"kinematics.{kind}"]
            analyzer.walk(module, module.functions["load_kinematics"], "config", label,
                          when + (("printer", "kinematics", (kind,)),), None, conditional)

    return hook, kinds


def registry_hook(project, option, tables):
    """Aiguillage par un registre rempli à l'exécution (Kalico : `register_component`, puis
    `config.getchoice(option, printer.lookup_components(…))(config)`) : on suit la classe de chaque
    entrée des tables déclarées (module, nom du dictionnaire), avec la variante `option: clé`."""
    entries = []
    for module_name, table_name in tables:
        module = project.modules.get(module_name)
        table = module.dicts.get(table_name) if module else None
        if table is None:
            continue
        for key, value in zip(table.keys, table.values):
            if isinstance(key, ast.Constant) and isinstance(value, ast.Name):
                entries.append((module, key.value, value.id))

    def hook(analyzer, label, when, conditional):
        for module, key, class_name in entries:
            target = analyzer.method_target(module, class_name, "__init__", 1)
            if target:
                analyzer.walk(target[0], target[1], target[1].args.args[1].arg, label,
                              when + ((label, option, (key,)),), None, conditional)

    return hook


# Registres de Kalico (crochets déclarés) : appelé → (option, tables).
REGISTRIES = {
    "kalico": {
        ("extras.load_cell", "sensor_class"): ("sensor_type", [
            ("extras.load_cell.hx71x", "HX71X_SENSOR_TYPES"),
            ("extras.load_cell.ads1220", "ADS1220_SENSOR_TYPE"),
            ("extras.load_cell.ads131m0x", "ADS131M0X_SENSOR_TYPES"),
        ]),
        ("extras.load_cell_probe", "sensor_class"): ("sensor_type", [
            ("extras.load_cell.hx71x", "HX71X_SENSOR_TYPES"),
            ("extras.load_cell.ads1220", "ADS1220_SENSOR_TYPE"),
            ("extras.load_cell.ads131m0x", "ADS131M0X_SENSOR_TYPES"),
        ]),
    },
}


def sensor_families(project, defaults):
    """Capteurs enregistrés par `add_sensor_factory(nom, fabrique)` dans tous les modules."""
    families = []
    for module in project.modules.values():
        for function in [*module.functions.values(), *(m for c in module.classes.values() for m in c["methods"].values())]:
            loops = {}
            instances = {}
            for node in ast.walk(function):
                if isinstance(node, ast.For):
                    loops[id(node)] = node
                if (isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name) and isinstance(node.value, ast.Call)
                        and isinstance(node.value.func, ast.Name) and node.value.func.id in module.classes):
                    instances[node.targets[0].id] = node.value.func.id
            for node in ast.walk(function):
                if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                        and node.func.attr == "add_sensor_factory" and len(node.args) == 2):
                    continue
                name_node, factory = node.args
                # Seule la boucle qui contient l'appel compte (deux boucles peuvent réutiliser un nom).
                enclosing = {k: loop for k, loop in loops.items() if any(n is node for n in ast.walk(loop))}
                names, custom = names_of(module, function, name_node, enclosing, instances)
                families.append({"module": module, "names": names, "custom": custom, "factory": factory,
                                 "function": function, "instances": instances, "loops": enclosing})
    for family in families:
        if family["custom"]:
            family["names"] = sorted(defaults.get(family["custom"], []))
    return families


def loop_items(module, loop):
    """`for a, b in LISTE` / `for a, b in DICT.items()` / `for a in LISTE` → [(a, b)] littéraux."""
    iterable = loop.iter
    if isinstance(iterable, ast.Call) and isinstance(iterable.func, ast.Attribute) and iterable.func.attr == "items":
        iterable = iterable.func.value
    source = None
    if isinstance(iterable, ast.Name):
        source = next((n.value for n in module.tree.body if isinstance(n, ast.Assign)
                       and isinstance(n.targets[0], ast.Name) and n.targets[0].id == iterable.id), None)
    items = []
    if isinstance(source, ast.Dict):
        items = [(k, v) for k, v in zip(source.keys, source.values)]
    elif isinstance(source, (ast.List, ast.Tuple)):
        for element in source.elts:
            if isinstance(element, ast.Tuple) and len(element.elts) >= 2:
                items.append((element.elts[0], element.elts[1]))
            else:
                items.append((element, None))
    return items


def names_of(module, function, node, loops, instances):
    if isinstance(node, ast.Constant):
        return [node.value], None
    if isinstance(node, ast.Attribute) and node.attr == "name":
        # Capteur personnalisé : son nom est celui de la section [module NOM].
        return [], module.name.split(".")[-1]
    if isinstance(node, ast.Name):
        for loop in loops.values():
            target = loop.target
            first = target.elts[0].id if isinstance(target, ast.Tuple) and isinstance(target.elts[0], ast.Name) else getattr(target, "id", None)
            if first == node.id:
                return [ast.literal_eval(k) for k, _ in loop_items(module, loop) if isinstance(k, ast.Constant)], None
    return [], None


def factory_targets(analyzer, family):
    """Fabrique → [(module, fonction, paramètre de la section)]."""
    module, factory = family["module"], family["factory"]
    targets = []
    # `func = (lambda config, params=params: …)` ou `def func(config, params=params): …` dans la
    # fonction, puis `add_sensor_factory(nom, func)` : la fabrique locale.
    if isinstance(factory, ast.Name):
        # La boucle qui contient l'appel d'abord : deux boucles peuvent réutiliser le même nom
        # (`func` pour les capteurs en tension, puis en résistance).
        scopes = [*family["loops"].values(), family["function"]]
        for node in (n for scope in scopes for n in ast.walk(scope)):
            if (isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name)
                    and node.targets[0].id == factory.id and isinstance(node.value, ast.Lambda)):
                factory = node.value
                break
            if isinstance(node, ast.FunctionDef) and node.name == factory.id and node is not family["function"]:
                return [(module, node, 0)]
    if isinstance(factory, ast.Name):
        for loop in family["loops"].values():
            target = loop.target
            if isinstance(target, ast.Tuple) and len(target.elts) >= 2 and getattr(target.elts[1], "id", None) == factory.id:
                for _, value in loop_items(module, loop):
                    if isinstance(value, ast.Name):
                        targets.append(analyzer.resolve(module, value, {"class": None, "types": {}, "choices": {}}))
                return [t for t in targets if t]
        resolved = analyzer.resolve(module, factory, {"class": None, "types": {}, "choices": {}})
        return [resolved] if resolved else []
    if isinstance(factory, ast.Attribute) and isinstance(factory.value, ast.Name):
        class_name = family["instances"].get(factory.value.id)
        if class_name:
            found = analyzer.method_target(module, class_name, factory.attr, 1)
            return [found] if found else []
    if isinstance(factory, ast.Lambda):
        function = ast.FunctionDef(name="<lambda>", args=factory.args, body=[ast.Return(value=factory.body)],
                                   decorator_list=[], lineno=factory.lineno)
        return [(module, function, 0)]
    return []


def sensor_hook(families):
    """extras/heaters.py : `self.sensor_factories[sensor_type](config)`."""

    def hook(analyzer, label, when, conditional):
        for family in families:
            condition = ("self", "sensor_type", tuple(family["names"]), family["custom"])
            for target in factory_targets(analyzer, family):
                module, function, offset = target
                params = [a.arg for a in function.args.args]
                if len(params) > offset:
                    analyzer.walk(module, function, params[offset], label, when + (condition,), None, conditional)

    return hook


def temperature_sensor_defaults(klippy):
    """Capteurs prédéfinis de extras/temperature_sensors.cfg : « thermistor NOM » → NOM."""
    parser = configparser.RawConfigParser(strict=False)
    parser.read_string((klippy / "extras" / "temperature_sensors.cfg").read_text(encoding="utf8"))
    defaults = {}
    for section in parser.sections():
        prefix, _, name = section.partition(" ")
        # « [adc_temperature] » seul ne fait que charger le module : pas un nom de capteur.
        if name:
            defaults.setdefault(prefix, []).append(name)
    return defaults


# --- Fusion des lectures d'une option ----------------------------------------------------------

def merge(reads):
    typed = [r for r in reads if "type" in r]
    info = {}
    if typed:
        non_string = [r for r in typed if r["type"] != "string"]
        # Types différents selon le chemin (registre TMC booléen ou entier) : pas de contrôle de type.
        info["type"] = "mixed" if len({r["type"] for r in non_string}) > 1 else (non_string or typed)[0]["type"]
        levels = {r["required"] for r in typed}
        info["required"] = "always" if "always" in levels else "conditional" if "conditional" in levels else "never"
        default = next((r for r in typed if "default" in r), None)
        if default is not None:
            info["default"] = default["default"]
        # Une borne ne s'applique que si TOUTES les lectures la posent ; la plus lâche est gardée
        # (aucun faux positif si deux lectures diffèrent).
        for bound, loosest in (("minval", min), ("above", min), ("maxval", max), ("below", max)):
            values = [r.get(bound) for r in typed]
            if all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in values):
                info[bound] = loosest(values)
        choices = [r["choices"] for r in typed if "choices" in r]
        if choices and len(choices) == len([r for r in typed if r["type"] == "choice"]) and all(r["type"] == "choice" for r in typed):
            info["choices"] = sorted(set().union(*choices))
        # Séparateurs et nombre d'éléments : ceux des lectures du type retenu (une lecture
        # `get` préalable, sans séparateur, ne doit pas les effacer : `trigger_phase: 10/128`).
        same_type = [r for r in typed if r["type"] == info["type"]]
        for key in ("count", "sep", "seps"):
            values = {json.dumps(r.get(key)) for r in same_type}
            if same_type and len(values) == 1 and key in same_type[0] and same_type[0][key] != "calculée":
                info[key] = same_type[0][key]
    if any(r.get("deprecated") for r in reads):
        info["deprecated"] = True
    if any(r.get("template") for r in reads):
        info["template"] = True
    info["sources"] = sorted({r["source"] for r in reads})
    return info


def main():
    for firmware in sys.argv[1:] or list(FIRMWARES):
        generate(firmware)
    write_signatures()


def write_signatures():
    """Indices de chaque fork (EP-01.17) : sections et options qu'il connaît et Klipper non.

    Les options supprimées de Klipper (curated.json) sont exclues : un fork fondé sur un Klipper
    ancien les lit encore, mais une vieille configuration de Klipper aussi, ce n'est pas un indice.
    """
    folder = PACKAGE / "src" / "config" / "schema"
    load = lambda firmware: json.loads(
        (folder / f"{firmware}-{FIRMWARES[firmware]['commit'][:10]}.json").read_text(encoding="utf8"))
    base = load("klipper")
    removed = {entry["option"] for entry in base["removed"]}
    sections = lambda s: set(s["modules"]["exact"]) | {f"{m} " for m in s["modules"]["prefix"]}
    # Noms d'options que Klipper lit dans une section quelconque : jamais un indice de fork.
    known = {o for r in base["rules"] for o in r["options"]}
    # Modules installés à part sur Klipper (gcode_shell_command, z_calibration…) : un fork peut les
    # embarquer, mais un utilisateur de Klipper aussi ; ce ne sont pas des indices.
    forks = {"kalico", "creality", "qidi"}
    addons = {s for o in base["outsideKlipper"] if o["origin"] not in forks for s in o.get("sections", [])}
    raw = {}
    for firmware in FIRMWARES:
        if firmware == "klipper":
            continue
        schema = load(firmware)
        addon_rule = lambda regex: any(re.match(regex, name) or re.match(regex, f"{name} x") for name in addons)
        raw[firmware] = (
            {s for s in sections(schema) - sections(base) if s.strip() not in addons},
            {
                (r["regex"], o) for r in schema["rules"] for o in r["options"]
                if o not in known and o not in removed and not addon_rule(r["regex"])
            },
        )
    # Indice partagé par des forks de familles différentes : pas discriminant. Les deux Qidi
    # forment une famille (mêmes indices, départagés par ceux propres à chaque branche).
    family = lambda fw: "qidi" if fw.startswith("qidi") else fw
    count = lambda index, item: len({family(fw) for fw, sets in raw.items() if item in sets[index]})
    signatures = {}
    for firmware, (fork_sections, fork_options) in raw.items():
        signatures[firmware] = {
            "commit": FIRMWARES[firmware]["commit"],
            # « nom » : section exacte ; « nom » suivi d'une espace : préfixe ([nom quelque_chose]).
            "sections": sorted(s for s in fork_sections if count(0, s) == 1),
            "options": [[regex, option] for regex, option in sorted(fork_options) if count(1, (regex, option)) == 1],
        }
    out = folder / "firmware-signatures.json"
    out.write_text(json.dumps(signatures, ensure_ascii=False, indent=1) + "\n", encoding="utf8", newline="\n")
    print(f"{out.name} : " + ", ".join(
        f"{fw} {len(s['sections'])} sections et {len(s['options'])} options propres" for fw, s in signatures.items()))


def generate(firmware):
    commit = FIRMWARES[firmware]["commit"]
    klippy = fetch(firmware) / "klippy"
    project = Project(klippy)
    defaults = temperature_sensor_defaults(klippy)
    kin_hook, kinds = kinematics_hook(project)
    families = sensor_families(project, defaults)
    analyzer = Analyzer(project, {})
    analyzer.hooks = {("toolhead", "load_kinematics"): kin_hook, ("extras.heaters", "sensor_factories"): sensor_hook(families)}
    for callee, (option, tables) in REGISTRIES.get(firmware, {}).items():
        analyzer.hooks[callee] = registry_hook(project, option, tables)

    # Points d'entrée : les objets du cœur (klippy.py `_read_config`), puis chaque module extras
    # chargé par `load_object` : `load_config` pour [module], `load_config_prefix` pour [module nom].
    for name in ("pins", "mcu", "toolhead"):
        module = project.modules[name]
        analyzer.walk(module, module.functions["add_printer_objects"], "config", "printer", ())
    exact, prefixed = [], []
    for name, module in sorted(project.modules.items()):
        if not name.startswith("extras.") or name.count(".") != 1:
            continue
        short = name.split(".", 1)[1]
        if "load_config" in module.functions:
            exact.append(short)
            analyzer.walk(module, module.functions["load_config"], "config", short, ())
        if "load_config_prefix" in module.functions:
            prefixed.append(short)
            analyzer.walk(module, module.functions["load_config_prefix"], "config", f"{short} {{*}}", ())

    # Points d'entrée déclarés du firmware ; « heaters » : toutes les sections qui lisent heater_pin.
    for entry in FIRMWARES[firmware].get("entries", []):
        module = project.modules[entry["module"]]
        class_name, _, method = entry["function"].rpartition(".")
        function = module.classes[class_name]["methods"][method]
        heaters = sorted({label for (label, when), rule in analyzer.reads.rules.items() if "heater_pin" in rule["options"]})
        for label in heaters if entry["labels"] == "heaters" else [entry["labels"]]:
            if entry.get("list"):
                # Paramètre recevant une LISTE de sections (`DisplayGroup(config, nom, data_configs)`).
                analyzer.walk(module, function, "__list__", label, (), lists={entry["param"]: [label]})
            else:
                analyzer.walk(module, function, entry["param"], label, ())
            # Section propre au point d'entrée ([pid_profile …]) : lue par le firmware, donc connue.
            if entry["labels"] != "heaters":
                analyzer.reads.accessed.add(label)

    curated = json.loads((HERE / "curated.json").read_text(encoding="utf8"))
    changes_file = klippy.parent / "docs" / "Config_Changes.md"
    changes = changes_file.read_text(encoding="utf8") if changes_file.exists() else ""

    rules = []
    for (label, when), rule in sorted(analyzer.reads.rules.items(), key=lambda item: (item[0][0], str(item[0][1]))):
        conditions = []
        for section, option, values, *custom in when:
            condition = {"section": "self" if section == label else section, "option": option, "values": list(values)}
            if custom and custom[0]:
                condition["sectionPrefix"] = custom[0]
            conditions.append(condition)
        options = {name: merge(entry["reads"]) for name, entry in sorted(rule["options"].items())}
        rules.append({
            "label": label,
            "regex": label_regex(label),
            **({"when": conditions} if conditions else {}),
            "options": options,
            **({"patterns": {label_regex(p)[1:-1]: {k: v for k, v in info.items() if k != "reads"} for p, info in sorted(rule["patterns"].items())}} if rule["patterns"] else {}),
        })

    for entry in curated["removed"] if firmware == "klipper" else []:
        # Garde-fou : chaque option supprimée est bien citée dans Config_Changes.md (de Klipper ;
        # un fork garde les options qu'il lit encore : le schéma les connaît alors).
        if entry["option"] not in changes:
            raise SystemExit(f"Option supprimée absente de Config_Changes.md : {entry['option']}")

    commands, dynamic = command_table(project)
    schema = {
        "firmware": firmware,
        "commit": commit,
        **({"interpolation": True} if FIRMWARES[firmware].get("interpolation") else {}),
        # Sections dont une partie des lectures échappe à l'analyse (menus) : pas d'« option inconnue ».
        "openSections": sorted(label_regex(label) for label in analyzer.reads.open),
        "kinematics": kinds,
        "sensorFamilies": [
            {"names": f["names"], **({"sectionPrefix": f["custom"]} if f["custom"] else {}), "module": f["module"].name}
            for f in families
        ],
        "modules": {"exact": exact, "prefix": prefixed},
        "accessedSections": sorted(label_regex(a) for a in analyzer.reads.accessed if UNKNOWN not in a),
        "rules": rules,
        "removed": curated["removed"],
        "outsideKlipper": curated["outsideKlipper"],
        # Commandes G-code du firmware (lint des macros, EP-06.08).
        "commands": commands,
    }
    out = PACKAGE / "src" / "config" / "schema" / f"{firmware}-{commit[:10]}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(schema, ensure_ascii=False, indent=1) + "\n", encoding="utf8", newline="\n")
    report = HERE / f"unresolved-{firmware}.txt"
    report.write_text("\n".join(sorted(set(analyzer.reads.unresolved))) + "\n", encoding="utf8", newline="\n")
    print(f"{out.name} : {len(rules)} règles, {sum(len(r['options']) for r in rules)} options ; "
          f"{len(set(analyzer.reads.unresolved))} appels non résolus (unresolved-{firmware}.txt) ; "
          f"{len(commands['always'])} commandes de base, commandes dynamiques ignorées : {', '.join(dynamic) or 'aucune'}")


if __name__ == "__main__":
    main()
