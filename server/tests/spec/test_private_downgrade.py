"""The edition-neutral executable rollback check, acceptance 29/31/32/42."""

import json
import socket
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

SCRIPT = Path(__file__).parents[3] / "scripts" / "check-private-downgrade"


@pytest.mark.parametrize(
    "state,target,warn",
    [
        (
            {"release": "2026.10.17-aaaaaaa", "private_floor": "2026.10.16-bbbbbbb"},
            "2026.10.15-ccccccc",
            True,
        ),
        (
            {"release": "2026.10.17-aaaaaaa", "private_floor": "2026.10.16-bbbbbbb"},
            "2026.10.16-bbbbbbb",
            False,
        ),
        (
            {"release": "2026.10.17-aaaaaaa", "private_floor": "2026.10.16-bbbbbbb"},
            "2026.10.18-ccccccc",
            False,
        ),
        ({"release": "2026.10.17-aaaaaaa", "private_floor": None}, "2026.10.15-ccccccc", False),
        ({}, "2026.10.18-ccccccc", True),
        ({"release": "2026.10.17-aaaaaaa"}, "2026.10.18-ccccccc", True),
        ({"release": "2026.10.17-aaaaaaa", "private_floor": "unknown"}, "2026.10.18-ccccccc", True),
        (
            {"release": "2026.10.17-aaaaaaa", "private_floor": "2026.10.16-bbbbbbb"},
            "2026.10.16-ccccccc",
            True,
        ),
    ],
)
def test_warns_for_unsafe_or_unknown_and_requires_explicit_confirmation(state, target, warn):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            assert self.path == "/.well-known/porchsite-release"
            assert self.headers["User-Agent"] == "porchsite-check-private-downgrade/" + target
            self.send_response(200)
            self.end_headers()
            self.wfile.write(json.dumps(state).encode())

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("localhost", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        command = [
            sys.executable,
            str(SCRIPT),
            "--site",
            f"http://localhost:{server.server_port}",
            "--target",
            target,
        ]
        result = subprocess.run(command, capture_output=True, text=True, timeout=15)
        assert result.returncode == (1 if warn else 0)
        if warn:
            for text in ("site public", "older releases", "minimum release", "owner explicitly"):
                assert text in result.stderr
            confirmed = subprocess.run(
                [*command, "--confirm"], capture_output=True, text=True, timeout=15
            )
            assert confirmed.returncode == 0
            assert "site public" in confirmed.stderr
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def test_http_refusal_reports_status_and_sends_user_agent():
    agents = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            agents.append(self.headers.get("User-Agent"))
            self.send_response(403)
            self.end_headers()

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("localhost", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        command = [
            sys.executable,
            str(SCRIPT),
            "--site",
            f"http://localhost:{server.server_port}",
            "--target",
            "2026.10.18-ccccccc",
        ]
        refused = subprocess.run(command, capture_output=True, text=True, timeout=15)
        assert refused.returncode == 1
        assert "HTTP 403" in refused.stderr and "site public" in refused.stderr
        confirmed = subprocess.run(
            [*command, "--confirm"], capture_output=True, text=True, timeout=15
        )
        assert confirmed.returncode == 0 and "HTTP 403" in confirmed.stderr
        assert agents == ["porchsite-check-private-downgrade/2026.10.18-ccccccc"] * 2
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def test_network_refusal_reports_reason_and_stops():
    with socket.socket() as reserved:
        reserved.bind(("127.0.0.1", 0))  # reserved but deliberately not listening
        command = [
            sys.executable,
            str(SCRIPT),
            "--site",
            f"http://127.0.0.1:{reserved.getsockname()[1]}",
            "--target",
            "2026.10.18-ccccccc",
        ]
        result = subprocess.run(command, capture_output=True, text=True, timeout=15)
    assert result.returncode == 1
    assert "Network error:" in result.stderr and "site public" in result.stderr
