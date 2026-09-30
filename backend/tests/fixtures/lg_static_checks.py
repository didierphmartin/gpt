# backend/tests/fixtures/lg_static_checks.py
"""Static checks over generated LangGraph Python (driven by LangGraphOutputStructureTest).

Usage: python3 lg_static_checks.py <check> <file.py>...   (stdlib only)
  undefined    names read but never bound anywhere in the file (same rule as GeneratedDocParityTest's checker)
  unused       top-level imports (incl. inside a top-level try/if) that the file never uses
  docstrings   classes, and public functions/methods (top level or in a class), without a docstring
  readability  what the spec's readability rule forbids: Protocol, __slots__/slots=True, singledispatch,
               metaclasses, a match nested in a match, a class more than one level below its root,
               a class that is a single helper (one method, no instance state)
  docs         the documentation inventory: every comment line and docstring line, whitespace-normalised,
               banners and the volatile "Generated:" line dropped; printed sorted and unique over ALL files
Findings print as "<file>: <finding>" (docs prints bare lines). Always exits 0; the test decides.
"""
import ast, builtins, io, re, sys, tokenize


def undefined(tree):
    # Module dunders are bound by the import system, not by builtins; __file__ is the one
    # dir(builtins) lacks, the others are listed so the rule reads complete.
    known = set(dir(builtins)) | {"__file__", "__name__", "__doc__", "__package__", "__spec__"}
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            known.add(node.name)
        elif isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
            known.add(node.id)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            for a in node.names:
                known.add((a.asname or a.name).split(".")[0])
        elif isinstance(node, ast.ExceptHandler) and node.name:
            known.add(node.name)
        elif isinstance(node, ast.arg):
            known.add(node.arg)
        elif isinstance(node, ast.Global):
            known.update(node.names)
        elif isinstance(node, ast.MatchAs) and node.name:
            known.add(node.name)
        elif isinstance(node, ast.MatchStar) and node.name:
            known.add(node.name)
        elif isinstance(node, ast.MatchMapping) and node.rest:
            known.add(node.rest)
    used = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load)}
    return [f"undefined name {n}" for n in sorted(used - known)]


def _top_imports(stmts):
    for s in stmts:
        if isinstance(s, (ast.Import, ast.ImportFrom)):
            yield s
        elif isinstance(s, (ast.Try, ast.If)):
            yield from _top_imports(s.body)
            yield from _top_imports(s.orelse)
            for h in getattr(s, "handlers", []):
                yield from _top_imports(h.body)


def unused(tree):
    imported = {}
    for s in _top_imports(tree.body):
        if isinstance(s, ast.ImportFrom) and s.module == "__future__":
            continue
        for a in s.names:
            imported[(a.asname or a.name).split(".")[0]] = s.lineno
    used = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)}
    for n in ast.walk(tree):   # string annotations such as "T.AgentCard" still use T
        if isinstance(n, ast.Constant) and isinstance(n.value, str):
            used.update(re.findall(r"^([A-Za-z_]\w*)\.", n.value))
    return [f"unused import {k} (line {v})" for k, v in sorted(imported.items()) if k not in used]


def docstrings(tree):
    out = []

    def visit(body, owner=""):
        for n in body:
            if isinstance(n, ast.ClassDef):
                if not ast.get_docstring(n):
                    out.append(f"class {n.name} has no docstring")
                visit(n.body, n.name + ".")
            elif isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
                if not n.name.startswith("_") and not ast.get_docstring(n):
                    out.append(f"def {owner}{n.name} has no docstring")
    visit(tree.body)
    return out


def readability(tree, src):
    out = [f"uses {w}" for w in ("typing.Protocol", "(Protocol)", "__slots__", "slots=True", "singledispatch") if w in src]
    classes = {n.name: n for n in ast.walk(tree) if isinstance(n, ast.ClassDef)}

    def depth(name, seen=()):
        node = classes.get(name)
        if node is None or name in seen:
            return 0
        parents = [b.id for b in node.bases if isinstance(b, ast.Name) and b.id in classes]
        return 1 + max((depth(p, seen + (name,)) for p in parents), default=-1) if parents else 0
    def methods_of(node):
        return [m for m in node.body if isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef)) and not m.name.startswith("__")]

    def has_state(node):
        return any(isinstance(t, ast.Attribute) and isinstance(t.value, ast.Name) and t.value.id == "self"
                   for m in ast.walk(node) if isinstance(m, (ast.Assign, ast.AnnAssign, ast.AugAssign))
                   for t in (m.targets if isinstance(m, ast.Assign) else [m.target]))
    for name, node in classes.items():
        if depth(name) > 1:
            out.append(f"class {name} is more than one level below its root")
        if any(k.arg == "metaclass" for k in node.keywords):
            out.append(f"class {name} uses a metaclass")
        plain_bases = {b.id for b in node.bases if isinstance(b, ast.Name)}
        # A one-method subclass of a same-file base that groups state or several actions
        # (Node -> DispatcherNode) overrides that base's action; the base is the class, not a helper.
        real_base = any(b in classes and (has_state(classes[b]) or len(methods_of(classes[b])) >= 2) for b in plain_bases)
        if len(methods_of(node)) <= 1 and not has_state(node) and not real_base \
                and not plain_bases & {"TypedDict", "Exception", "ABC"} \
                and not any(isinstance(s, (ast.Assign, ast.AnnAssign)) for s in node.body):
            out.append(f"class {name} is a single helper (one method, no state)")
    for m in ast.walk(tree):
        if isinstance(m, ast.Match):
            for inner in ast.walk(m):
                if inner is not m and isinstance(inner, ast.Match):
                    out.append(f"match nested in a match at line {inner.lineno}")
    return out


def docs(tree, src):
    lines = [t.string.lstrip("#") for t in tokenize.generate_tokens(io.StringIO(src).readline) if t.type == tokenize.COMMENT]
    for n in ast.walk(tree):
        if isinstance(n, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            d = ast.get_docstring(n, clean=True)
            if d:
                lines.extend(d.splitlines())
    out = set()
    for line in lines:
        line = " ".join(line.split())
        if not line or re.fullmatch(r"[=\-─_*#~]+", line) or line.startswith("Generated:"):
            continue
        out.add(line)
    return out


def main():
    check, paths = sys.argv[1], sys.argv[2:]
    inventory = set()
    for path in paths:
        src = open(path, encoding="utf-8").read()
        tree = ast.parse(src)
        match check:
            case "undefined":
                findings = undefined(tree)
            case "unused":
                findings = unused(tree)
            case "docstrings":
                findings = docstrings(tree)
            case "readability":
                findings = readability(tree, src)
            case "docs":
                inventory |= docs(tree, src)
                continue
            case _:
                raise SystemExit(f"unknown check {check}")
        for f in findings:
            print(f"{path}: {f}")
    if check == "docs":
        print("\n".join(sorted(inventory)))


main()
