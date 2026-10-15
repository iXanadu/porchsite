"""Cleanup failures survive expected failures, without a database or network."""

import json
import os
import runpy
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]

FAKE_PYTHON = r'''
import json, os, signal, sys, time
from pathlib import Path
trace = Path(os.environ["CLEANUP_TRACE"])
def record(event, **values):
    with trace.open("a") as f:
        f.write(json.dumps({"event": event, **values}) + "\n")
a = sys.argv[1:]
if a[0] == "-":
    if a[1] == "drop":
        record("drop", name=a[-1])
        if os.environ.get("INJECT_DROP_FAILURE") == "1":
            print("injected drop failure", file=sys.stderr)
            sys.exit(1)
    else:
        record("create", name=a[-1])
elif a[0] == "-c":
    if "urlsplit" in a[1]:
        print("postgresql://test@localhost:5433/" + a[-1])
    elif "socket.socket" in a[1]:
        print("12345")
    elif "httpx.get" in a[1]:
        sys.exit(0 if trace.exists() and '"event": "started"' in trace.read_text() else 1)
elif a[:2] == ["-m", "uvicorn"]:
    def stop(*_):
        record("closed")
        sys.exit(0)
    signal.signal(signal.SIGTERM, stop)
    record("started")
    while True:
        time.sleep(.05)
elif a[:2] == ["-m", "server.app.cli"]:
    print("fixture-token")
else:
    expected = {
        "guard-off": "S6 content that looks like a secret is refused",
        "stale-update": "S3 an update from an old version is refused",
        "no-replay": "S4 a replayed create returns the same item",
        "hotlink": "S7 an outside image is copied in or refused, never linked",
    }.get(os.environ.get("PORCHSITE_MUTATION"))
    print("FAIL  " + expected if expected else "PASS  fixture check")
    sys.exit(1 if expected else 0)
'''


@pytest.mark.parametrize("script", ["conformance-server.sh", "conformance-mutations.sh"])
@pytest.mark.parametrize("fail_drop", [False, True])
def test_cleanup_status_and_database_name_survive_the_wrapper(tmp_path, script, fail_drop):
    python = tmp_path / "python-fixture"
    python.write_text(f"#!{sys.executable}\n" + FAKE_PYTHON)
    python.chmod(0o700)
    trace = tmp_path / "trace.jsonl"
    env = {
        **os.environ,
        "PYTHON": str(python),
        "PORCHSITE_TEST_DSN": "postgresql://test@localhost:5433/postgres",
        "CLEANUP_TRACE": str(trace),
        "INJECT_DROP_FAILURE": "1" if fail_drop else "0",
    }
    env.pop("PORCHSITE_MUTATION", None)
    result = subprocess.run(
        [str(ROOT / "scripts" / script)], env=env, capture_output=True, text=True, timeout=30
    )
    output = result.stdout + result.stderr
    assert bool(result.returncode) == fail_drop, output
    events = [json.loads(line) for line in trace.read_text().splitlines()]
    dropped = [e["name"] for e in events if e["event"] == "drop"]
    assert len(dropped) == (4 if script == "conformance-mutations.sh" else 1)
    previous = None
    for event in events:
        if event["event"] == "drop":
            assert previous == "closed", events
        previous = event["event"]
    if fail_drop:
        for name in dropped:
            assert f"could not drop {name}" in output
        if script == "conformance-mutations.sh":
            assert "FAIL  S6 content that looks like a secret is refused" in output
            assert "mutations: every one caught" not in output


def test_pytest_cleanup_failure_names_database_and_closes_connections(monkeypatch):
    monkeypatch.setenv("PORCHSITE_TEST_DSN", "postgresql://test@localhost:5433/postgres")
    fixture = runpy.run_path(str(ROOT / "server/tests/app/conftest.py"))
    connections = []

    class Connection:
        closed = False

        async def execute(self, sql):
            if sql.startswith("DROP DATABASE"):
                assert all(c.closed for c in connections[:-1])
                raise RuntimeError("injected drop failure")

        async def close(self):
            self.closed = True

    async def connect(_):
        conn = Connection()
        connections.append(conn)
        return conn

    async def schema(_):
        pass

    monkeypatch.setattr(fixture["asyncpg"], "connect", connect)
    function = fixture["test_dsn"].__wrapped__
    monkeypatch.setitem(function.__globals__, "apply_schema", schema)
    generator = function()
    dsn = next(generator)
    name = dsn.rsplit("/", 1)[1]
    with pytest.raises(RuntimeError, match=f"could not drop {name}"):
        generator.close()
    assert all(c.closed for c in connections)
