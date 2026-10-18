#!/usr/bin/env python3
"""The compatibility rule, checked: every schema change is additive, so the
previous release runs on the new schema and a rollback is only a re-upload.

Checks, in both editions:
  cloudflare/migrations/*.sql            (the Cloudflare edition's D1 files)
  server/server/app/schema.sql           (the server edition's base schema)
  server/server/app/db.py MIGRATIONS     (the server edition's later changes)

Allowed: CREATE TABLE; CREATE INDEX; CREATE UNIQUE INDEX on a table made in
the same migration; ALTER TABLE ... ADD COLUMN that is nullable or has a
DEFAULT (and is not PRIMARY KEY or UNIQUE); INSERT into a table made in the
same migration. Refused: DROP, RENAME, ALTER COLUMN, ADD CONSTRAINT, a NOT
NULL column without DEFAULT, a UNIQUE index on an existing table, triggers
on existing tables, and any INSERT/UPDATE/DELETE/REPLACE/TRUNCATE on an
existing table (a rewrite the previous release may not read). Anything not
recognised is refused too: check it by hand and teach this script.

schema.sql is applied at every start, so it may hold only
CREATE ... IF NOT EXISTS, and it never changes once released (later changes
go in MIGRATIONS).

With --base <git revision> (the previous release's commit) it also checks
that history is append-only: every migration file and MIGRATIONS entry of
that revision is still here, unchanged and in order, and schema.sql is
byte-identical.

  scripts/migration-check.py [--rev <git rev>] [--base <git rev>]

--rev checks a commit instead of the working tree. Exit 1 on any violation.
Standard library only.
"""

import argparse
import ast
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CF_DIR = "cloudflare/migrations"
SCHEMA = "server/server/app/schema.sql"
DB_PY = "server/server/app/db.py"


# --- reading a tree: the working tree, or a git revision ---------------------------------


class Tree:
    def __init__(self, rev: str | None):
        self.rev = rev

    def read(self, path: str) -> str | None:
        if self.rev is None:
            p = ROOT / path
            return p.read_text(encoding="utf-8") if p.exists() else None
        r = subprocess.run(
            ["git", "-C", str(ROOT), "show", f"{self.rev}:{path}"],
            capture_output=True,
            text=True,
        )
        return r.stdout if r.returncode == 0 else None

    def ls(self, directory: str) -> list[str]:
        if self.rev is None:
            d = ROOT / directory
            return sorted(p.name for p in d.iterdir()) if d.is_dir() else []
        r = subprocess.run(
            ["git", "-C", str(ROOT), "ls-tree", "--name-only", f"{self.rev}:{directory}"],
            capture_output=True,
            text=True,
        )
        return sorted(r.stdout.split()) if r.returncode == 0 else []

    def cf_migrations(self) -> list[tuple[str, str]]:
        names = [n for n in self.ls(CF_DIR) if n.endswith(".sql")]
        return [(n, self.read(f"{CF_DIR}/{n}") or "") for n in names]

    def server_migrations(self) -> list[tuple[str, str]]:
        src = self.read(DB_PY)
        if src is None:
            return []
        for node in ast.parse(src).body:
            target = None
            if isinstance(node, ast.Assign) and len(node.targets) == 1:
                target = node.targets[0]
            elif isinstance(node, ast.AnnAssign):
                target = node.target
            if isinstance(target, ast.Name) and target.id == "MIGRATIONS":
                return [tuple(x) for x in ast.literal_eval(node.value)]  # type: ignore[arg-type]
        raise SystemExit(f"{DB_PY}: no MIGRATIONS list found")


# --- SQL -------------------------------------------------------------------------------------


from sql_statements import statements, canonical
from content_revision_sql import migration as witness_migration


NAME = r'"?([A-Za-z_][A-Za-z0-9_]*)"?'
CREATE_TABLE = re.compile(rf"^CREATE TABLE (IF NOT EXISTS )?{NAME}", re.I)
CREATE_INDEX = re.compile(rf"^CREATE (UNIQUE )?INDEX (IF NOT EXISTS )?{NAME} ON {NAME}", re.I)
ADD_COLUMN = re.compile(rf"^ALTER TABLE {NAME} ADD (COLUMN )?(IF NOT EXISTS )?{NAME} (.*)$", re.I)
WRITE = re.compile(
    rf"^(INSERT( OR \w+)? INTO|REPLACE INTO|UPDATE|DELETE FROM|TRUNCATE( TABLE)?) {NAME}", re.I
)
TRIGGER = re.compile(
    rf"^CREATE (TEMP |TEMPORARY )?TRIGGER (IF NOT EXISTS )?{NAME} .*? ON {NAME}", re.I
)


def check_statement(stmt: str, known: set[str], made: set[str]) -> str | None:
    """None when the statement is additive; else why not. Updates `made`."""
    head = stmt.upper()
    if m := CREATE_TABLE.match(stmt):
        name = m.group(2).lower()
        if name in known and not m.group(1):
            return f"recreates existing table {name}"
        if name not in known:
            made.add(name)
        return None
    if m := CREATE_INDEX.match(stmt):
        table = m.group(4).lower()
        if m.group(1) and table in known:
            return f"UNIQUE index on existing table {table}: the previous release may write rows it refuses"
        return None
    if m := ADD_COLUMN.match(stmt):
        table, rest = m.group(1).lower(), m.group(5).upper()
        if m.group(4).upper() in ("CONSTRAINT", "PRIMARY", "UNIQUE", "FOREIGN", "CHECK"):
            return f"ADD {m.group(4).upper()} on table {table}: a new constraint may refuse the previous release's writes"
        if table in made:
            return None
        if re.search(r"\bNOT NULL\b", rest) and not re.search(r"\bDEFAULT\b", rest):
            return f"NOT NULL column without DEFAULT on existing table {table}: the previous release's inserts fail"
        if re.search(r"\b(PRIMARY KEY|UNIQUE)\b", rest):
            return f"PRIMARY KEY/UNIQUE column on existing table {table}"
        return None
    if m := WRITE.match(stmt):
        table = m.group(4).lower()
        if table in made:
            return None
        return f"writes existing table {table}: a data rewrite the previous release may not read"
    if m := TRIGGER.match(stmt):
        table = m.group(4).lower()
        return None if table in made else f"trigger on existing table {table}"
    for word, why in (
        ("DROP ", "DROP: the previous release still uses it"),
        (
            "ALTER TABLE",
            "ALTER TABLE other than ADD COLUMN (rename, drop, alter column or constraint)",
        ),
        ("RENAME", "RENAME: the previous release still uses the old name"),
    ):
        if head.startswith(word) or (word == "RENAME" and " RENAME " in head):
            return why
    return "not recognised as additive (check by hand; teach scripts/migration-check.py)"


def check_schema_sql(sql: str) -> tuple[list[str], set[str]]:
    errors, tables = [], set()
    for s in statements(sql):
        if m := CREATE_TABLE.match(s):
            if not m.group(1):
                errors.append(f"{SCHEMA}: CREATE TABLE {m.group(2)} without IF NOT EXISTS")
            tables.add(m.group(2).lower())
        elif m := CREATE_INDEX.match(s):
            if not m.group(2):
                errors.append(f"{SCHEMA}: CREATE INDEX {m.group(3)} without IF NOT EXISTS")
        else:
            errors.append(f"{SCHEMA}: only CREATE ... IF NOT EXISTS belongs here: {s[:80]}")
    return errors, tables


def witness_allowance(parts: list[str], dialect: str) -> tuple[set, list[str]]:
    # Any attempt to introduce the witness must install the entire fixed
    # inventory. Whole token equality includes every body, not just its name.
    if not any(re.search(r"\b(?:content_revision|advance_content_revision|content_revision__\w+)\b", x, re.I) for x in parts):
        return set(), []
    expected = witness_migration(dialect)
    keys = [canonical(x) for x in parts]
    required = [canonical(x) for x in expected]
    if len(keys) != len(required) or set(keys) != set(required):
        return set(), ['witness migration requires the complete exact table, trigger/function inventory and seed']
    if keys[0] != required[0] or keys[-1] != required[-1]:
        return set(), ['witness table must precede triggers and the non-resetting seed must be last']
    if dialect == 'pg' and keys[1] != required[1]:
        return set(), ['witness function must precede its triggers']
    return set(required), []


def check_list(label: str, migrations: list[tuple[str, str]], known: set[str]) -> list[str]:
    errors = []
    known = set(known)
    for name, sql in migrations:
        made: set[str] = set()
        try:
            parts = statements(sql)
        except ValueError as error:
            errors.append(f"{label} {name}: {error}")
            continue
        allowed, problems = witness_allowance(parts, 'cf' if label == CF_DIR else 'pg')
        errors.extend(f"{label} {name}: {why}" for why in problems)
        for s in parts:
            if canonical(s) in allowed:
                if m := CREATE_TABLE.match(s):
                    if m.group(2).lower() not in known:
                        made.add(m.group(2).lower())
                continue
            why = check_statement(s, known, made)
            if why:
                errors.append(f"{label} {name}: {why}\n    {s[:160]}")
        known |= made
    return errors


def check_tree(tree: Tree) -> list[str]:
    errors = []
    cf = tree.cf_migrations()
    names = [n for n, _ in cf]
    for n in names:
        if not re.fullmatch(r"\d{4}_[a-z0-9_]+\.sql", n):
            errors.append(f"{CF_DIR}/{n}: name must be NNNN_words.sql")
    nums = [n[:4] for n in names]
    if len(set(nums)) != len(nums):
        errors.append(f"{CF_DIR}: two files share a number")
    errors += check_list(CF_DIR, cf, set())
    schema = tree.read(SCHEMA)
    known: set[str] = set()
    if schema is not None:
        e, known = check_schema_sql(schema)
        errors += e
    sv = tree.server_migrations()
    if len({n for n, _ in sv}) != len(sv):
        errors.append(f"{DB_PY}: two MIGRATIONS share a name")
    errors += check_list(f"{DB_PY} MIGRATIONS", sv, known)
    return errors


def check_append_only(base: Tree, head: Tree) -> list[str]:
    errors = []
    now = dict(head.cf_migrations())
    for name, sql in base.cf_migrations():
        if name not in now:
            errors.append(f"{CF_DIR}/{name}: released in {base.rev}, now missing")
        elif now[name] != sql:
            errors.append(
                f"{CF_DIR}/{name}: released in {base.rev}, now changed (add a new file instead)"
            )
    old, new = base.server_migrations(), head.server_migrations()
    if new[: len(old)] != old:
        errors.append(
            f"{DB_PY} MIGRATIONS: the entries released in {base.rev} must stay first, unchanged and in order"
        )
    b, h = base.read(SCHEMA), head.read(SCHEMA)
    if b is not None and h != b:
        errors.append(
            f"{SCHEMA}: changed since {base.rev}; it is frozen once released (use MIGRATIONS)"
        )
    return errors


# Statements the rule must refuse, and ones it must let through (--self-test).
MUST_REFUSE = [
    "DROP TABLE items",
    "DROP INDEX items_kind",
    "ALTER TABLE items RENAME TO things",
    "ALTER TABLE items RENAME COLUMN data TO body",
    "ALTER TABLE items DROP COLUMN kind",
    "ALTER TABLE items ADD COLUMN z TEXT NOT NULL",
    "ALTER TABLE items ALTER COLUMN kind SET NOT NULL",
    "ALTER TABLE items ADD CONSTRAINT c CHECK (version > 0)",
    "ALTER TABLE items ADD COLUMN u TEXT UNIQUE",
    "UPDATE items SET kind = 'page'",
    "DELETE FROM items",
    "INSERT INTO items (id) VALUES ('x')",
    "TRUNCATE items",
    "CREATE UNIQUE INDEX items_kind_u ON items (kind)",
    "CREATE TRIGGER t AFTER INSERT ON items BEGIN SELECT 1; END",
    "PRAGMA foreign_keys = ON",
]
MUST_ALLOW = [
    "CREATE TABLE notes2 (id TEXT PRIMARY KEY, body TEXT NOT NULL)",
    "INSERT INTO notes2 (id, body) VALUES ('a', 'b')",
    "CREATE UNIQUE INDEX notes2_body ON notes2 (body)",
    "CREATE INDEX IF NOT EXISTS items_kind ON items (kind)",
    "ALTER TABLE items ADD COLUMN note TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE items ADD COLUMN extra TEXT",
]


def self_test() -> int:
    bad = []
    for s in MUST_REFUSE:
        if not any(check_statement(x, {"items"}, set()) for x in statements(s)):
            bad.append(f"let through: {s}")
    made: set[str] = set()
    for s in MUST_ALLOW:
        why = check_statement(s, {"items"}, made)
        if why:
            bad.append(f"refused: {s} ({why})")
    for b in bad:
        print(f"  - {b}", file=sys.stderr)
    print(
        f"migration-check self-test: {'FAILED' if bad else 'ok'} ({len(MUST_REFUSE)} refused, {len(MUST_ALLOW)} allowed)"
    )
    parser_tests = subprocess.run([sys.executable, str(ROOT / 'scripts/test-migration-statements.py'), '-q'], check=False)
    return 1 if bad or parser_tests.returncode else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--rev", help="check this git revision instead of the working tree")
    ap.add_argument("--base", help="the previous release's git revision: also check append-only")
    ap.add_argument("--self-test", action="store_true", help="check the rule itself, then exit")
    a = ap.parse_args()
    if a.self_test:
        return self_test()
    head = Tree(a.rev)
    errors = check_tree(head)
    if a.base:
        errors += check_append_only(Tree(a.base), head)
    where = a.rev or "working tree"
    if errors:
        print(f"migration-check: {len(errors)} problem(s) in {where}:", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 1
    print(
        f"migration-check: ok ({where}: {len(head.cf_migrations())} Cloudflare files, "
        f"{len(head.server_migrations())} server migrations{', append-only since ' + a.base if a.base else ''})"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
