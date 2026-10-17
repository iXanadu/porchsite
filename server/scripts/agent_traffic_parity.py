"""Shared UC9 classification, report and owner HTML contract."""

import json
from pathlib import Path

from server.app.agent_traffic import agent_kind, format_traffic, traffic_html

cases = json.loads(
    (Path(__file__).resolve().parents[2] / "spec/agent-traffic-cases.json").read_text()
)
report = format_traffic(cases["rows"], "2026-10-16", "2026-10-17")
kinds = [agent_kind(c["ua"]) for c in cases["agents"]]
assert kinds == [c["kind"] for c in cases["agents"]]
print(
    json.dumps(
        {"kinds": kinds, "report": report, "html": traffic_html(report)}, separators=(",", ":")
    )
)
