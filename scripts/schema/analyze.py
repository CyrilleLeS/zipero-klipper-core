# SPDX-License-Identifier: GPL-3.0-only
"""Analyse statique du code de Klipper : quelles options chaque section lit (ADR 0022).

Le code n'est jamais exécuté. On suit la section `config` de fonction en fonction :
- lectures `config.get*('option', défaut, minval=…)`, `deprecate`, `get_prefix_options` ;
- appels où la section est passée en argument, résolus statiquement : fonction du module,
  classe (son __init__), `self.méthode`, `module_importé.fonction`, objet obtenu par
  `load_object(config, 'module')`, instance d'une classe connue ; les arguments littéraux sont
  propagés (`parse_config_pair(config, 'probe_count', …)` lit bien `probe_count`) ;
- sous-sections : `config.getsection('stepper_' + n)` (boucles sur littéraux développées),
  `config.get_prefix_sections('mcu ')`, `config.getsection(config.get_name() + str(i))` ;
- aiguillage par choix : `algo = config.getchoice('control', algos)` puis `algo(self, config)`
  produit une variante par valeur (`control: pid` → options de ControlPID).
Les aiguillages dynamiques restants (cinématique chargée par importlib, capteurs enregistrés par
`add_sensor_factory`) passent par des crochets déclarés dans generate.py.

Obligation : une lecture sans valeur par défaut, sur un chemin sans condition (ni `if`, ni boucle,
ni retour anticipé) depuis le point d'entrée, est « always » ; sans défaut mais conditionnelle,
« conditional » ; avec défaut, « never ».
"""
import ast
from pathlib import Path

GET_TYPES = {
    "get": "string",
    "getint": "int",
    "getfloat": "float",
    "getboolean": "boolean",
    "getchoice": "choice",
    "getlist": "list",
    "getintlist": "int_list",
    "getfloatlist": "float_list",
    "getlists": "lists",
}
BOUNDS = ("minval", "maxval", "above", "below")
UNKNOWN = "{?}"


def literal(node, module=None):
    try:
        return ast.literal_eval(node)
    except (ValueError, SyntaxError, TypeError):
        if module is not None and isinstance(node, ast.Name) and node.id in module.constants:
            return module.constants[node.id]
        return "calculée"


class Module:
    def __init__(self, name, path):
        self.name = name
        self.path = path
        self.tree = ast.parse(path.read_text(encoding="utf8"))
        self.functions = {}
        self.classes = {}
        self.imports = {}
        self.constants = {}
        self.dicts = {}
        for node in self.tree.body:
            if isinstance(node, ast.FunctionDef):
                self.functions[node.name] = node
            elif isinstance(node, ast.ClassDef):
                methods = {n.name: n for n in node.body if isinstance(n, ast.FunctionDef)}
                bases = [b.id for b in node.bases if isinstance(b, ast.Name)]
                self.classes[node.name] = {"node": node, "methods": methods, "bases": bases}
            elif isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
                target = node.targets[0].id
                try:
                    self.constants[target] = ast.literal_eval(node.value)
                except (ValueError, SyntaxError, TypeError):
                    pass
                if isinstance(node.value, ast.Dict):
                    self.dicts[target] = node.value
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    self.imports[alias.asname or alias.name] = ("abs", alias.name)
            elif isinstance(node, ast.ImportFrom):
                for alias in node.names:
                    self.imports[alias.asname or alias.name] = ("from", node.module or "", node.level, alias.name)


class Project:
    """Tous les modules de klippy/ (cœur, extras, kinematics), indexés par nom pointé."""

    def __init__(self, klippy: Path):
        self.root = klippy
        self.modules = {}
        for path in sorted(klippy.rglob("*.py")):
            relative = path.relative_to(klippy).with_suffix("")
            parts = list(relative.parts)
            if parts[-1] == "__init__":
                parts = parts[:-1]
            if not parts:
                continue
            self.modules[".".join(parts)] = Module(".".join(parts), path)

    def resolve_import(self, module, name):
        """Nom importé → (module, symbole ou None si c'est un module)."""
        entry = module.imports.get(name)
        if entry is None:
            return None
        package = module.name.rsplit(".", 1)[0] if "." in module.name else ""
        if entry[0] == "abs":
            target = entry[1]
            for candidate in (target, f"{package}.{target}" if package else target):
                if candidate in self.modules:
                    return candidate, None
            return None
        _, source, level, symbol = entry
        base = module.name.split(".")
        # Dans un paquet (__init__.py), « from . import x » part du paquet lui-même.
        if module.path.name == "__init__.py":
            base = [*base, "__init__"]
        base = base[: len(base) - level] if level else []
        source_path = ".".join(base + ([source] if source else []))
        as_module = f"{source_path}.{symbol}" if source_path else symbol
        if as_module in self.modules:
            return as_module, None
        if source_path in self.modules:
            return source_path, symbol
        return None


class Reads:
    """Résultat : règles par (section, conditions) → options lues, motifs, sections accédées."""

    def __init__(self):
        self.rules = {}
        self.accessed = set()
        self.unresolved = []

    def rule(self, label, when):
        return self.rules.setdefault((label, when), {"options": {}, "patterns": {}})

    def add_option(self, label, when, name, info):
        options = self.rule(label, when)["options"]
        entry = options.setdefault(name, {"reads": []})
        entry["reads"].append(info)


def literal_nonempty(node):
    """Itérable littéral non vide (`'xyz'`, `['a', 'b']`) : la boucle s'exécute toujours."""
    try:
        value = ast.literal_eval(node)
    except (ValueError, SyntaxError, TypeError):
        return False
    return isinstance(value, (str, list, tuple)) and len(value) > 0


def loop_bindings(function):
    """Variable de boucle ou de compréhension → valeurs, quand l'itérable est un littéral."""
    values = {}
    for node in ast.walk(function):
        if isinstance(node, (ast.For, ast.comprehension)) and isinstance(node.target, ast.Name):
            try:
                iterable = ast.literal_eval(node.iter)
            except (ValueError, SyntaxError, TypeError):
                continue
            if isinstance(iterable, (str, list, tuple)) and all(isinstance(v, str) for v in iterable):
                values.setdefault(node.target.id, []).extend(iterable)
    return values


def string_values(node, bindings, aliases):
    """Valeurs possibles d'une expression de nom (option ou section). `{n}` : entier, `{*}` : texte."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return [node.value]
    if isinstance(node, ast.Name) and node.id in bindings:
        return list(bindings[node.id])
    if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and f"{node.value.id}.{node.attr}" in bindings:
        return list(bindings[f"{node.value.id}.{node.attr}"])
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        return [a + b for a in string_values(node.left, bindings, aliases) for b in string_values(node.right, bindings, aliases)]
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Mod) and isinstance(node.left, ast.Constant):
        template = str(node.left.value)
        args = node.right.elts if isinstance(node.right, ast.Tuple) else [node.right]
        for arg in args:
            values = string_values(arg, bindings, aliases)
            placeholder = values[0] if len(values) == 1 and UNKNOWN not in values[0] else None
            for spec in ("%s", "%d", "%i"):
                if spec in template:
                    template = template.replace(spec, placeholder or ("{n}" if spec != "%s" else "{*}"), 1)
                    break
        return [template]
    if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in ("upper", "lower", "strip")
            and not node.args):
        transform = {"upper": str.upper, "lower": str.lower, "strip": str.strip}[node.func.attr]
        return [v if UNKNOWN in v else transform(v) for v in string_values(node.func.value, bindings, aliases)]
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "chr":
        # `chr(ord('a') + i)` : une lettre (moteurs stepper_a, stepper_b… de winch).
        return ["{a}"]
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "str" and node.args:
        values = string_values(node.args[0], bindings, aliases)
        return ["{n}" if UNKNOWN in v else v for v in values]
    if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "get_name"
            and isinstance(node.func.value, ast.Name) and node.func.value.id in aliases):
        return [aliases[node.func.value.id]]
    if isinstance(node, ast.JoinedStr):
        parts = []
        for value in node.values:
            if isinstance(value, ast.Constant):
                parts.append(str(value.value))
            else:
                inner = string_values(value.value, bindings, aliases) if isinstance(value, ast.FormattedValue) else [UNKNOWN]
                parts.append(inner[0] if len(inner) == 1 else UNKNOWN)
        return ["".join(parts)]
    return [UNKNOWN]


class Analyzer:
    def __init__(self, project, hooks):
        self.project = project
        self.hooks = hooks
        self.reads = Reads()
        self.seen = set()

    # --- résolution des appels ---------------------------------------------------------------
    def class_method(self, module, class_name, method):
        info = module.classes.get(class_name)
        while info is not None:
            if method in info["methods"]:
                return info["methods"][method]
            info = module.classes.get(info["bases"][0]) if info["bases"] else None
        return None

    def resolve(self, module, func, context):
        """Appel → (module, nœud de fonction, décalage des arguments) ou None."""
        cls = context["class"]
        if isinstance(func, ast.Name) and func.id in context.get("callables", {}):
            return context["callables"][func.id]
        # self.fields.set_config_field(…) : objet rangé dans un attribut de self.
        if (isinstance(func, ast.Attribute) and isinstance(func.value, ast.Attribute)
                and isinstance(func.value.value, ast.Name) and func.value.value.id == "self"):
            kind = context["types"].get(f"self.{func.value.attr}")
            if kind and kind[0] == "instance":
                method = self.class_method(kind[1], kind[2], func.attr)
                return (kind[1], method, 1) if method else None
            return None
        # kinematics.extruder.add_printer_objects(…) : module désigné par un nom pointé.
        if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Attribute):
            dotted = ast.unparse(func.value)
            if dotted in self.project.modules:
                target = self.project.modules[dotted]
                return self.resolve(target, ast.Name(id=func.attr), {"class": None, "types": {}, "choices": {}})
            return None
        if isinstance(func, ast.Name):
            name = func.id
            if name in context["choices"]:
                return None
            if name in module.functions:
                return module, module.functions[name], 0
            if name in module.classes:
                init = self.class_method(module, name, "__init__")
                return (module, init, 1) if init else None
            imported = self.project.resolve_import(module, name)
            if imported and imported[1]:
                target = self.project.modules[imported[0]]
                return self.resolve(target, ast.Name(id=imported[1]), {"class": None, "types": {}, "choices": {}})
            return None
        if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name):
            owner, attr = func.value.id, func.attr
            if owner == "self" and cls:
                method = self.class_method(module, cls, attr)
                return (module, method, 1) if method else None
            # Parent.__init__(self, config) : self est passé explicitement.
            if owner in module.classes:
                method = self.class_method(module, owner, attr)
                return (module, method, 0) if method else None
            kind = context["types"].get(owner)
            if kind and kind[0] == "instance":
                target, class_name = kind[1], kind[2]
                method = self.class_method(target, class_name, attr)
                return (target, method, 1) if method else None
            if kind and kind[0] == "modules":
                for name in kind[1]:
                    target = self.project.modules.get(f"extras.{name}")
                    if target is None:
                        continue
                    for class_name in target.classes:
                        method = self.class_method(target, class_name, attr)
                        if method:
                            return target, method, 1
                return None
            imported = self.project.resolve_import(module, owner)
            if imported and imported[1] is None:
                target = self.project.modules[imported[0]]
                return self.resolve(target, ast.Name(id=attr), {"class": None, "types": {}, "choices": {}})
        if isinstance(func, ast.Attribute):
            return self.unique_method(func.attr)
        return None

    def unique_method(self, name):
        """Méthode définie par UNE SEULE classe de Klipper : l'appel est sans ambiguïté."""
        if not hasattr(self, "_methods"):
            self._methods = {}
            for module in self.project.modules.values():
                for info in module.classes.values():
                    for method_name, node in info["methods"].items():
                        self._methods.setdefault(method_name, []).append((module, node))
        found = self._methods.get(name, [])
        return (found[0][0], found[0][1], 1) if len(found) == 1 and not name.startswith("__") else None

    # --- parcours ----------------------------------------------------------------------------
    def walk(self, module, function, param, label, when, bindings=None, conditional=False):
        """Suit la section `label` reçue par le paramètre `param` (nom) de `function`."""
        bindings = dict(bindings or {})
        key = (module.name, function.name, function.lineno, param, label, when, tuple(sorted((k, tuple(v)) for k, v in bindings.items())), conditional)
        if key in self.seen:
            return
        self.seen.add(key)
        cls = next((c for c, info in module.classes.items() if function in info["methods"].values()), None)
        for name, values in loop_bindings(function).items():
            bindings.setdefault(name, values)
        # Valeurs par défaut littérales des paramètres (`pin_option="cs_pin"`).
        positional = function.args.args
        for arg, default in zip(positional[len(positional) - len(function.args.defaults):], function.args.defaults):
            if isinstance(default, ast.Constant) and isinstance(default.value, str):
                bindings.setdefault(arg.arg, [default.value])
        context = {"class": cls, "types": {}, "choices": {}, "lists": {}, "multi": {}}
        aliases = {param: label}
        self.block(module, function.body, aliases, context, bindings, when, conditional)

    def block(self, module, statements, aliases, context, bindings, when, conditional):
        returned = False
        for statement in statements:
            cond = conditional or returned
            if isinstance(statement, ast.If):
                self.expression(module, statement.test, aliases, context, bindings, when, cond)
                self.block(module, statement.body, dict(aliases), context, bindings, when, True)
                self.block(module, statement.orelse, dict(aliases), context, bindings, when, True)
                # Un retour anticipé rend la suite conditionnelle ; une exception non : une
                # configuration valide ne la lève pas, la suite est toujours lue.
                if any(isinstance(n, ast.Return) for n in ast.walk(statement)):
                    returned = True
                continue
            if isinstance(statement, (ast.For, ast.While)):
                always = False
                if isinstance(statement, ast.For):
                    self.expression(module, statement.iter, aliases, context, bindings, when, cond)
                    self.loop_alias(statement, aliases, context)
                    always = literal_nonempty(statement.iter)
                self.block(module, statement.body, aliases, context, bindings, when, cond if always else True)
                self.block(module, statement.orelse, aliases, context, bindings, when, True)
                continue
            if isinstance(statement, ast.Try):
                self.block(module, statement.body, aliases, context, bindings, when, cond)
                for handler in statement.handlers:
                    self.block(module, handler.body, aliases, context, bindings, when, True)
                self.block(module, statement.orelse, aliases, context, bindings, when, cond)
                self.block(module, statement.finalbody, aliases, context, bindings, when, cond)
                continue
            if isinstance(statement, ast.With):
                self.block(module, statement.body, aliases, context, bindings, when, cond)
                continue
            if isinstance(statement, (ast.FunctionDef, ast.ClassDef)):
                continue
            if isinstance(statement, ast.Assign):
                self.assignment(module, statement, aliases, context, bindings)
            for child in ast.iter_child_nodes(statement):
                self.expression(module, child, aliases, context, bindings, when, cond)
            if isinstance(statement, ast.Return) and not conditional:
                returned = True

    def section_label(self, node, aliases, bindings):
        """`x.getsection(expr)` → étiquette de la sous-section, sinon None."""
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "getsection"
                and isinstance(node.func.value, ast.Name) and node.func.value.id in aliases and node.args):
            values = string_values(node.args[0], bindings, aliases)
            for value in values:
                self.reads.accessed.add(value)
            return values
        return None

    def alias_of(self, node, aliases, context):
        """Étiquettes de section d'une expression (variable, élément de liste de sections)."""
        if isinstance(node, ast.Name) and node.id in aliases:
            return [aliases[node.id]]
        if isinstance(node, ast.Name) and node.id in context["multi"]:
            return context["multi"][node.id]
        if isinstance(node, ast.Subscript) and isinstance(node.value, ast.Name) and node.value.id in context["lists"]:
            labels = context["lists"][node.value.id]
            # Indice littéral (`stepper_configs[0]`) : la seule section désignée.
            if isinstance(node.slice, ast.Constant) and isinstance(node.slice.value, int) and -len(labels) <= node.slice.value < len(labels):
                return [labels[node.slice.value]]
            return labels
        return None

    def instance_type(self, module, call):
        """`Classe(…)` ou `module.Classe(…)` → ("instance", module, classe)."""
        func = call.func
        if isinstance(func, ast.Name) and func.id in module.classes:
            return ("instance", module, func.id)
        if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name):
            imported = self.project.resolve_import(module, func.value.id)
            if imported and imported[1] is None:
                target = self.project.modules[imported[0]]
                if func.attr in target.classes:
                    return ("instance", target, func.attr)
        return None

    def assignment(self, module, statement, aliases, context, bindings):
        target = statement.targets[0] if len(statement.targets) == 1 else None
        value = statement.value
        # self.fields = tmc.FieldHelper(…) ; self.name = config.get_name()
        if isinstance(target, ast.Attribute) and isinstance(target.value, ast.Name) and target.value.id == "self":
            names = string_values(value, bindings, aliases)
            if names and UNKNOWN not in "".join(names):
                bindings[f"self.{target.attr}"] = names
            elif isinstance(value, ast.Call):
                kind = self.instance_type(module, value)
                if kind:
                    context["types"][f"self.{target.attr}"] = kind
            return
        if not isinstance(target, ast.Name):
            return
        name = target.id
        # set_config_field = self.fields.set_config_field
        if isinstance(value, ast.Attribute):
            resolved = self.resolve(module, value, context)
            if resolved:
                context.setdefault("callables", {})[name] = resolved
                return
        # prefix = "screw%d" % (i + 1,) : nom construit, gardé comme motif.
        values = string_values(value, bindings, aliases)
        if values and UNKNOWN not in "".join(values) and not isinstance(value, ast.Call):
            # Affectations successives (`s = 'extruder'` puis `if i: s = 'extruder%d' % i`) :
            # toutes les valeurs restent possibles.
            bindings[name] = list(dict.fromkeys([*bindings.get(name, []), *values]))
            return
        labels = self.section_label(value, aliases, bindings)
        if labels is not None:
            if len(labels) == 1:
                aliases[name] = labels[0]
            return
        if isinstance(value, ast.ListComp):
            inner = {**bindings, **loop_bindings(value)}
            labels = self.section_label(value.elt, aliases, inner)
            if labels:
                context["lists"][name] = labels
                return
            # sw_pin_names = ['spi_software_%s_pin' % (n,) for n in ['miso', 'mosi', 'sclk']]
            names = string_values(value.elt, inner, aliases)
            if names and UNKNOWN not in "".join(names):
                bindings[name] = names
                return
        if isinstance(value, ast.Call):
            func = value.func
            # obj = printer.load_object(config, 'heaters') / lookup_object('heaters')
            if isinstance(func, ast.Attribute) and func.attr in ("load_object", "lookup_object"):
                arg = value.args[1] if func.attr == "load_object" and len(value.args) > 1 else (value.args[0] if value.args else None)
                if arg is not None:
                    modules = [v.split()[0] for v in string_values(arg, bindings, aliases) if UNKNOWN not in v]
                    if modules:
                        context["types"][name] = ("modules", modules)
                return
            # algo = config.getchoice('control', algos)
            if (isinstance(func, ast.Attribute) and func.attr == "getchoice" and isinstance(func.value, ast.Name)
                    and func.value.id in aliases and len(value.args) >= 2):
                options = string_values(value.args[0], bindings, aliases)
                choices = value.args[1]
                table = module.dicts.get(choices.id) if isinstance(choices, ast.Name) else choices
                if isinstance(choices, ast.Name) and table is None:
                    table = context.get("local_dicts", {}).get(choices.id)
                if isinstance(table, ast.Dict) and len(options) == 1:
                    context["choices"][name] = (aliases[func.value.id], options[0], table)
                return
            # instance = MaClasse(...) / module.MaClasse(...)
            kind = self.instance_type(module, value)
            if kind:
                context["types"][name] = kind
        if isinstance(value, ast.Dict):
            context.setdefault("local_dicts", {})[name] = value

    def loop_alias(self, statement, aliases, context):
        """`for s in config.get_prefix_sections('mcu ')` → s est la section « mcu {*} »."""
        iterable = statement.iter
        if (isinstance(statement.target, ast.Name) and isinstance(iterable, ast.Call)
                and isinstance(iterable.func, ast.Attribute) and iterable.func.attr == "get_prefix_sections"
                and isinstance(iterable.func.value, ast.Name) and iterable.func.value.id in aliases and iterable.args):
            prefixes = string_values(iterable.args[0], {}, aliases)
            if len(prefixes) == 1 and UNKNOWN not in prefixes[0]:
                label = prefixes[0] + "{*}"
                self.reads.accessed.add(label)
                aliases[statement.target.id] = label
        elif isinstance(statement.target, ast.Name) and isinstance(iterable, ast.Name) and iterable.id in context["lists"]:
            labels = context["lists"][iterable.id]
            if len(labels) == 1:
                aliases[statement.target.id] = labels[0]

    def expression(self, module, node, aliases, context, bindings, when, conditional):
        if node is None:
            return
        if isinstance(node, ast.IfExp):
            self.expression(module, node.test, aliases, context, bindings, when, conditional)
            self.expression(module, node.body, aliases, context, bindings, when, True)
            self.expression(module, node.orelse, aliases, context, bindings, when, True)
            return
        if isinstance(node, ast.BoolOp):
            self.expression(module, node.values[0], aliases, context, bindings, when, conditional)
            for value in node.values[1:]:
                self.expression(module, value, aliases, context, bindings, when, True)
            return
        if isinstance(node, (ast.ListComp, ast.SetComp, ast.GeneratorExp, ast.DictComp)):
            inner = {**bindings, **loop_bindings(node)}
            for generator in node.generators:
                iterable, target = generator.iter, generator.target
                # zip(sections, autres) : le premier élément de la cible parcourt les sections.
                if (isinstance(iterable, ast.Call) and isinstance(iterable.func, ast.Name) and iterable.func.id == "zip"
                        and iterable.args and isinstance(target, ast.Tuple)):
                    iterable, target = iterable.args[0], target.elts[0]
                if not isinstance(target, ast.Name) or not isinstance(iterable, ast.Name):
                    continue
                if iterable.id in context["lists"]:
                    context["multi"][target.id] = context["lists"][iterable.id]
                elif iterable.id in inner:
                    inner[target.id] = inner[iterable.id]
            # Compréhension sur des littéraux non vides : toujours exécutée.
            always = all(literal_nonempty(g.iter) and not g.ifs for g in node.generators)
            for child in ast.iter_child_nodes(node):
                self.expression(module, child, aliases, context, inner, when, conditional if always else True)
            return
        if isinstance(node, ast.Lambda):
            return
        if isinstance(node, ast.Call):
            self.call(module, node, aliases, context, bindings, when, conditional)
        for child in ast.iter_child_nodes(node):
            self.expression(module, child, aliases, context, bindings, when, conditional)

    def call(self, module, node, aliases, context, bindings, when, conditional):
        func = node.func
        # Lecture sur une section, ou sur chaque section d'une liste (`stepper_configs[0]`, `sconfig`).
        receivers = self.alias_of(func.value, aliases, context) if isinstance(func, ast.Attribute) else None
        if receivers:
            method = func.attr
            for label in receivers:
                if method in GET_TYPES and node.args:
                    self.read(module, node, label, when, bindings, aliases, conditional, context)
                elif method == "deprecate" and node.args:
                    for name in string_values(node.args[0], bindings, aliases):
                        self.reads.add_option(label, when, name.lower(), {"deprecated": True, "source": f"{module.name}:{node.lineno}"})
                elif method == "get_prefix_options" and node.args:
                    for prefix in string_values(node.args[0], bindings, aliases):
                        self.reads.rule(label, when)["patterns"][prefix.lower() + "{*}"] = {"source": f"{module.name}:{node.lineno}"}
                elif method in ("has_section", "get_prefix_sections") and node.args:
                    for value in string_values(node.args[0], bindings, aliases):
                        self.reads.accessed.add(value + ("{*}" if method == "get_prefix_sections" else ""))
            if method in GET_TYPES or method in ("deprecate", "get_prefix_options", "has_section", "get_prefix_sections"):
                return
        # Aiguillage par choix (`algo(self, config)`).
        if isinstance(func, ast.Name) and func.id in context["choices"]:
            label_owner, option, table = context["choices"][func.id]
            for key_node, value_node in zip(table.keys, table.values):
                key = literal(key_node)
                if not isinstance(key, str) or not isinstance(value_node, ast.Name):
                    continue
                target = self.resolve(module, value_node, context)
                if target:
                    self.follow(module, node, target, aliases, context, bindings, when + ((label_owner, option.lower(), (key,)),), conditional)
            return
        target = self.resolve(module, func, context)
        # Nom de l'appelé pour les crochets : `mod.load_kinematics(…)`, `self.sensor_factories[…](…)`.
        callee = func.value if isinstance(func, ast.Subscript) else func
        hook = self.hooks.get((module.name, getattr(callee, "attr", getattr(callee, "id", None))))
        if target is None and hook is not None:
            for index, arg in enumerate(node.args):
                labels = self.alias_of(arg, aliases, context)
                if labels:
                    for label in labels:
                        hook(self, label, when, conditional)
            return
        if target is None:
            # load_object / lookup_object : chargent le module d'une AUTRE section, sans la lire.
            loader = isinstance(func, ast.Attribute) and func.attr in ("load_object", "lookup_object")
            if not loader and any(self.alias_of(a, aliases, context) for a in node.args):
                self.reads.unresolved.append(f"{module.name}:{node.lineno} {ast.unparse(func)}")
            return
        self.follow(module, node, target, aliases, context, bindings, when, conditional)

    def follow(self, module, node, target, aliases, context, bindings, when, conditional):
        target_module, function, offset = target
        params = [a.arg for a in function.args.args]
        literal_args = {}
        for index, arg in enumerate(node.args):
            if index + offset >= len(params):
                break
            values = string_values(arg, bindings, aliases)
            if UNKNOWN not in values[0] and not self.alias_of(arg, aliases, context):
                literal_args[params[index + offset]] = values
        for keyword in node.keywords:
            if keyword.arg:
                values = string_values(keyword.value, bindings, aliases)
                if UNKNOWN not in values[0]:
                    literal_args[keyword.arg] = values
        for index, arg in enumerate(node.args):
            if index + offset >= len(params):
                break
            labels = self.alias_of(arg, aliases, context) or self.section_label(arg, aliases, bindings)
            for label in labels or []:
                # Nouvelle section : l'obligation s'apprécie à partir de sa propre existence
                # ([extruder] n'est lue que si elle existe, mais alors heater_pin est exigé).
                same = label in aliases.values()
                self.walk(target_module, function, params[index + offset], label, when, literal_args, conditional if same else False)

    def read(self, module, node, label, when, bindings, aliases, conditional, context=None):
        method = node.func.attr
        names = string_values(node.args[0], bindings, aliases)
        kwargs = {kw.arg: kw.value for kw in node.keywords if kw.arg}
        default_index = 2 if method == "getchoice" else 1
        default_node = node.args[default_index] if len(node.args) > default_index else kwargs.get("default")
        info = {"type": GET_TYPES[method], "source": f"{module.name}:{node.lineno}"}
        if default_node is None:
            info["required"] = "conditional" if conditional else "always"
        else:
            info["required"] = "never"
            value = literal(default_node, module)
            info["default"] = value
        if method == "getchoice" and len(node.args) > 1:
            table = node.args[1]
            if isinstance(table, ast.Name):
                table = module.dicts.get(table.id) or (context or {}).get("local_dicts", {}).get(table.id, table)
            if isinstance(table, ast.Dict):
                info["choices"] = sorted(k for k in (literal(key) for key in table.keys) if isinstance(k, str))
            else:
                choices = literal(node.args[1], module)
                if isinstance(choices, (list, tuple, dict)):
                    info["choices"] = sorted(str(c) for c in choices)
        for bound in BOUNDS:
            if bound in kwargs:
                info[bound] = literal(kwargs[bound], module)
        for key in ("count", "sep", "seps"):
            if key in kwargs:
                info[key] = literal(kwargs[key], module)
        if method in ("getlist", "getintlist", "getfloatlist") and len(node.args) > 2 and "sep" not in info:
            info["sep"] = literal(node.args[2], module)
        for name in names:
            if UNKNOWN in name:
                self.reads.unresolved.append(f"{module.name}:{node.lineno} option {ast.unparse(node.args[0])}")
                continue
            if "{" in name:
                self.reads.rule(label, when)["patterns"][name.lower()] = info
            else:
                self.reads.add_option(label, when, name.lower(), info)
