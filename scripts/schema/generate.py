# SPDX-License-Identifier: GPL-3.0-only
"""Génère le schéma des options de configuration de Klipper (EP-01.10, EP-06.03, ADR 0022).

Usage (depuis packages/klipper-core) : python scripts/schema/generate.py [commit]
Télécharge Klipper au commit demandé (hors dépôt, dans le dossier temporaire), analyse son code
sans l'exécuter (analyze.py), applique la couche curée (curated.json) et écrit
src/config/schema/klipper-<commit>.json. Relancer après chaque nouvelle version de Klipper, puis
relire le diff du schéma.
"""
import ast
import configparser
import io
import json
import re
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from analyze import Analyzer, Project, UNKNOWN, string_values  # noqa: E402

HERE = Path(__file__).parent
PACKAGE = HERE.parent.parent
DEFAULT_COMMIT = "214fdb2877ff4640e9316a663c1b8b2e232c86fd"


def fetch(commit):
    cache = Path(tempfile.gettempdir()) / "klipper-src"
    root = cache / f"klipper-{commit}"
    if not root.exists():
        cache.mkdir(parents=True, exist_ok=True)
        data = urllib.request.urlopen(f"https://codeload.github.com/Klipper3d/klipper/tar.gz/{commit}").read()
        with tarfile.open(fileobj=io.BytesIO(data)) as archive:
            archive.extractall(cache, filter="data")
    return root


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
            method = analyzer.class_method(module, class_name, factory.attr)
            return [(module, method, 1)] if method else []
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
    info["sources"] = sorted({r["source"] for r in reads})
    return info


def main():
    commit = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_COMMIT
    klippy = fetch(commit) / "klippy"
    project = Project(klippy)
    defaults = temperature_sensor_defaults(klippy)
    kin_hook, kinds = kinematics_hook(project)
    families = sensor_families(project, defaults)
    analyzer = Analyzer(project, {})
    analyzer.hooks = {("toolhead", "load_kinematics"): kin_hook, ("extras.heaters", "sensor_factories"): sensor_hook(families)}

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

    curated = json.loads((HERE / "curated.json").read_text(encoding="utf8"))
    changes = (klippy.parent / "docs" / "Config_Changes.md").read_text(encoding="utf8")

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

    for entry in curated["removed"]:
        # Garde-fou : chaque option supprimée est bien citée dans Config_Changes.md.
        if entry["option"] not in changes:
            raise SystemExit(f"Option supprimée absente de Config_Changes.md : {entry['option']}")

    schema = {
        "firmware": "klipper",
        "commit": commit,
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
    }
    out = PACKAGE / "src" / "config" / "schema" / f"klipper-{commit[:10]}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(schema, ensure_ascii=False, indent=1) + "\n", encoding="utf8", newline="\n")
    report = HERE / "unresolved.txt"
    report.write_text("\n".join(sorted(set(analyzer.reads.unresolved))) + "\n", encoding="utf8", newline="\n")
    print(f"{out.name} : {len(rules)} règles, {sum(len(r['options']) for r in rules)} options ; "
          f"{len(set(analyzer.reads.unresolved))} appels non résolus (unresolved.txt)")


if __name__ == "__main__":
    main()
