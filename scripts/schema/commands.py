# SPDX-License-Identifier: GPL-3.0-only
"""Commandes G-code enregistrées par le firmware, par module (EP-06.08, ADR 0022).

Relève dans chaque module les appels `register_command("NOM", …)` et
`register_mux_command("NOM", …)` dont le nom est littéral (ou tiré d'une liste littérale parcourue
par une boucle), puis les dépendances entre modules : imports et `load_object(config, "module")`.
Résultat : les commandes toujours présentes (cœur de klippy, cinématiques et ce qu'ils chargent)
et, pour chaque préfixe de section, celles qu'ajoute le chargement de son module. Surestimation
assumée (un module importé est compté) : une commande n'est déclarée inconnue qu'avec certitude.
"""
import ast


def _literal_lists(function):
    """Listes littérales de chaînes affectées dans la fonction : nom → valeurs."""
    lists = {}
    for node in ast.walk(function):
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            if isinstance(node.value, (ast.List, ast.Tuple)) and all(
                    isinstance(e, ast.Constant) and isinstance(e.value, str) for e in node.value.elts):
                lists[node.targets[0].id] = [e.value for e in node.value.elts]
    return lists


def _loop_values(function, lists):
    """Variables de boucle `for x in [littéraux]` (ou liste littérale nommée) : nom → valeurs de
    toutes les boucles de la fonction qui la lient (virtual_sdcard en a deux sur `cmd`)."""
    bound = {}
    for node in ast.walk(function):
        if isinstance(node, ast.For) and isinstance(node.target, ast.Name):
            source = node.iter
            if isinstance(source, ast.Name) and source.id in lists:
                bound.setdefault(node.target.id, []).extend(lists[source.id])
            elif isinstance(source, (ast.List, ast.Tuple)) and all(
                    isinstance(e, ast.Constant) and isinstance(e.value, str) for e in source.elts):
                bound.setdefault(node.target.id, []).extend(e.value for e in source.elts)
    return bound


def _functions(tree):
    return [n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]


def _numbered(node):
    """Famille numérotée : `"O" + str(i)`, `"T{}".format(i)`, f"T{i}" → motif `^O[0-9]+$`."""
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add) and isinstance(node.left, ast.Constant) \
            and isinstance(node.left.value, str) and isinstance(node.right, ast.Call) \
            and isinstance(node.right.func, ast.Name) and node.right.func.id == "str":
        return f"^{node.left.value}[0-9]+$"
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "format" \
            and isinstance(node.func.value, ast.Constant) and str(node.func.value.value).endswith("{}"):
        return f"^{node.func.value.value[:-2]}[0-9]+$"
    if isinstance(node, ast.JoinedStr) and len(node.values) == 2 and isinstance(node.values[0], ast.Constant):
        return f"^{node.values[0].value}[0-9]+$"
    return None


def _numbered_lists(function):
    """Listes en compréhension de familles numérotées : nom → motif."""
    found = {}
    for node in ast.walk(function):
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name) \
                and isinstance(node.value, ast.ListComp):
            pattern = _numbered(node.value.elt)
            if pattern:
                found[node.targets[0].id] = pattern
    return found


def module_commands(module):
    """Commandes au nom connu, familles numérotées (motifs), enregistrements dynamiques restants."""
    names, patterns, dynamic = set(), set(), 0
    for function in _functions(module.tree):
        bound = _loop_values(function, _literal_lists(function))
        comprehensions = _numbered_lists(function)
        loops = {n.target.id: comprehensions[n.iter.id] for n in ast.walk(function)
                 if isinstance(n, ast.For) and isinstance(n.target, ast.Name)
                 and isinstance(n.iter, ast.Name) and n.iter.id in comprehensions}
        for node in ast.walk(function):
            if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                    and node.func.attr in ("register_command", "register_mux_command") and node.args):
                continue
            first = node.args[0]
            if isinstance(first, ast.Constant) and isinstance(first.value, str):
                names.add(first.value)
            elif isinstance(first, ast.Name) and first.id in bound:
                names.update(bound[first.id])
            elif isinstance(first, ast.Name) and first.id in loops:
                patterns.add(loops[first.id])
            elif _numbered(first):
                patterns.add(_numbered(first))
            else:
                dynamic += 1
    return names, patterns, dynamic


def module_dependencies(project, module):
    """Modules chargés par `load_object(config, "nom")`, et modules du projet importés."""
    deps, imports = set(), set()
    for name in module.imports:
        resolved = project.resolve_import(module, name)
        if resolved:
            imports.add(resolved[0])
    for function in [module.tree, *_functions(module.tree)]:
        # Modules chargés en boucle (toolhead.py : `for module_name in modules: load_object(…)`).
        bound = _loop_values(function, _literal_lists(function)) if function is not module.tree else {}
        for node in ast.walk(function):
            if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                    and node.func.attr == "load_object" and len(node.args) >= 2):
                continue
            arg = node.args[1]
            names = [arg.value] if isinstance(arg, ast.Constant) and isinstance(arg.value, str) else (
                bound.get(arg.id, []) if isinstance(arg, ast.Name) else [])
            for name in names:
                target = f"extras.{name.split()[0]}"
                if target in project.modules:
                    deps.add(target)
    return deps, imports


def command_table(project):
    """Commandes du firmware : certaines (module chargé et ce qu'il charge) et possibles (modules
    seulement importés, dont les classes peuvent enregistrer des commandes) ; motifs ; et
    enregistrements non résolus (hors gcode_macro, dont les commandes sont les macros)."""
    commands, patterns, dynamic, loads, imports = {}, {}, [], {}, {}
    for name, module in project.modules.items():
        commands[name], patterns[name], count = module_commands(module)
        if count and name not in ("extras.gcode_macro", "gcode"):
            dynamic.append(f"{name} ({count})")
        loads[name], imports[name] = module_dependencies(project, module)

    def closure(start, with_imports):
        seen, todo = set(), list(start)
        while todo:
            name = todo.pop()
            if name not in seen:
                seen.add(name)
                todo.extend(loads.get(name, ()))
                if with_imports:
                    todo.extend(imports.get(name, ()))
        return seen

    def union(modules, table):
        return set().union(*(table[m] for m in modules))

    # Toujours chargés : le cœur de klippy et les cinématiques (dont extruder), avec ce qu'ils chargent.
    roots = [n for n in project.modules if not n.startswith("extras.")]
    always = union(closure(roots, False), commands)
    always_possible = union(closure(roots, True), commands) - always
    sections, possible, section_patterns = {}, {}, {}
    for name in project.modules:
        if name.startswith("extras.") and name.count(".") == 1:
            prefix = name.split(".", 1)[1]
            certain = union(closure([name], False), commands) - always
            maybe = union(closure([name], True), commands) - always - certain
            found = union(closure([name], True), patterns)
            if certain:
                sections[prefix] = sorted(certain)
            if maybe:
                possible[prefix] = sorted(maybe)
            if found:
                section_patterns[prefix] = sorted(found)
    return {
        "always": sorted(always),
        "alwaysPossible": sorted(always_possible),
        "sections": sections,
        "possible": possible,
        "patterns": section_patterns,
    }, dynamic
