"""flask --app app cartograph files NAME | build: a map of which backend function calls which, across files.

Use it before touching code: `files` lists the files worth reading for one function; `build` writes a searchable page.
It resolves plain calls only (same-file calls, `from x import f`, `module.f()`, `self.f()`): ORM classes, calls through
variables and Flask route wiring are not followed, so treat the answer as a starting point.
"""
import ast
from pathlib import Path

import click
from flask.cli import AppGroup

BACKEND = Path(__file__).resolve().parent.parent
LAYERS = ("routes", "controllers", "services", "repositories", "models", "cli", "config")
cartograph_cli = AppGroup("cartograph", help="Map of backend functions and the functions they call across files.")


def build_graph(root: Path = BACKEND) -> tuple[list[dict], list[tuple[int, int, int]]]:
    """Return (functions, calls). A call is (caller index, callee index, line)."""
    files = [p for p in sorted(root.rglob("*.py")) if not {"tests", "__pycache__", "venv"} & set(p.relative_to(root).parts)]
    mod_of = {p: ".".join(p.relative_to(root).with_suffix("").parts).removesuffix(".__init__") for p in files}
    modules = set(mod_of.values())
    funcs: dict[str, dict] = {}

    class Collect(ast.NodeVisitor):
        def __init__(self, mod: str, rel: str):
            self.mod, self.rel, self.stack = mod, rel, []

        def visit_FunctionDef(self, node):
            name = ".".join(self.stack + [node.name])
            funcs[f"{self.mod}:{name}"] = dict(
                n=name, m=self.mod, f=self.rel, l=node.lineno, e=node.end_lineno,
                d=(ast.get_docstring(node) or "").split("\n")[0][:140],
                y=self.mod.split(".")[0] if self.mod.split(".")[0] in LAYERS else "app", node=node)
            self.stack.append(node.name)
            self.generic_visit(node)
            self.stack.pop()

        visit_AsyncFunctionDef = visit_FunctionDef

        def visit_ClassDef(self, node):
            self.stack.append(node.name)
            self.generic_visit(node)
            self.stack.pop()

    trees = {}
    for path in files:
        trees[path] = ast.parse(path.read_text())
        Collect(mod_of[path], str(path.relative_to(root))).visit(trees[path])
    by_mod: dict[str, dict[str, str]] = {}
    for key, info in funcs.items():
        by_mod.setdefault(info["m"], {})[info["n"]] = key
    edges: dict[tuple[str, str], int] = {}
    for path, tree in trees.items():
        mod, names = mod_of[path], {}
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
                for alias in node.names:
                    name, full = alias.asname or alias.name, f"{node.module}.{alias.name}"
                    if full in modules:
                        names[name] = ("mod", full)
                    elif node.module in modules:
                        names[name] = ("sym", node.module, alias.name)
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.name in modules:
                        names[alias.asname or alias.name] = ("mod", alias.name)
        for key, info in [(k, v) for k, v in funcs.items() if v["m"] == mod]:
            cls = info["n"].rsplit(".", 1)[0] if "." in info["n"] else None
            for call in ast.walk(info["node"]):
                if not isinstance(call, ast.Call):
                    continue
                fn, target = call.func, None
                if isinstance(fn, ast.Name):
                    if fn.id in by_mod.get(mod, {}):
                        target = by_mod[mod][fn.id]
                    elif names.get(fn.id, ("",))[0] == "sym":
                        target = by_mod.get(names[fn.id][1], {}).get(names[fn.id][2])
                elif isinstance(fn, ast.Attribute) and isinstance(fn.value, ast.Name):
                    owner = fn.value.id
                    if names.get(owner, ("",))[0] == "mod":
                        target = by_mod.get(names[owner][1], {}).get(fn.attr)
                    elif owner in ("self", "cls") and cls:
                        target = by_mod.get(mod, {}).get(f"{cls}.{fn.attr}")
                if target and target != key:
                    edges.setdefault((key, target), call.lineno)
    index = {key: i for i, key in enumerate(funcs)}
    functions = [{k: v for k, v in info.items() if k != "node"} for info in funcs.values()]
    return functions, [(index[a], index[b], line) for (a, b), line in edges.items()]


@cartograph_cli.command("files")
@click.argument("name")
@click.option("--depth", default=2, show_default=True, help="How many levels of called functions to follow.")
def files_command(name: str, depth: int) -> None:
    """Files to read before changing NAME (e.g. services.leads:create_lead; a part of the name is enough)."""
    funcs, calls = build_graph()
    needle = name.lower()
    hits = [i for i, f in enumerate(funcs) if needle in f"{f['m']}:{f['n']}".lower()]
    exact = [i for i in hits if f"{funcs[i]['m']}:{funcs[i]['n']}".lower() == needle]
    hits = exact or hits
    if len(hits) != 1:
        for i in hits[:20]:
            click.echo(f"{funcs[i]['m']}:{funcs[i]['n']}  ({funcs[i]['f']}:{funcs[i]['l']})")
        raise click.ClickException("No match." if not hits else "Several matches; use a longer name.")
    start = hits[0]
    reached, frontier = {start}, {start}
    for _ in range(depth):
        frontier = {b for a, b, _ in calls if a in frontier} - reached
        reached |= frontier
    callers = {a for a, b, _ in calls if b == start}
    f = funcs[start]
    click.echo(f"{f['m']}:{f['n']}  {f['f']}:{f['l']}-{f['e']}")
    click.echo(f"\nREAD (it and the functions it calls, {depth} levels):")
    for path in sorted({funcs[i]["f"] for i in reached}):
        click.echo(f"  {path}")
    others = sorted({funcs[i]["f"] for i in callers} - {f["f"]})
    click.echo("\nCHECK (direct callers; a changed signature or result may break them):")
    for path in others or ["(none)"]:
        click.echo(f"  {path}")
    stem = Path(f["f"]).name
    siblings = sorted(p for layer in LAYERS[:5] if (p := f"{layer}/{stem}") != f["f"] and (BACKEND / p).exists())
    click.echo("\nSAME MODULE IN OTHER LAYERS (routes → controllers → services → repositories → models; open one only if the change reaches that layer):")
    for path in siblings or ["(none)"]:
        click.echo(f"  {path}")


@cartograph_cli.command("build")
@click.option("--out", default=str(BACKEND / "cartograph.html"), show_default=True, type=click.Path(dir_okay=False))
def build_command(out: str) -> None:
    """Write the searchable HTML map (uses what it calls, who calls it, call tree)."""
    import json
    funcs, calls = build_graph()
    data = {"F": [{k: f[k] for k in ("n", "m", "f", "l", "e", "d", "y")} for f in funcs], "E": [list(c) for c in calls]}
    page = (Path(__file__).with_name("cartograph_template.html").read_text()
            .replace("__DATA__", json.dumps(data, separators=(",", ":"))))
    Path(out).write_text(page)
    across = sum(1 for a, b, _ in calls if funcs[a]["f"] != funcs[b]["f"])
    click.echo(f"{len(funcs)} functions, {len(calls)} calls ({across} across files) -> {out}")
