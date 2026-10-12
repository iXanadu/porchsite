"""Sitekeeper conformance check: is this site safe for an assistant to run?

Points at a live Sitekeeper site with an ASSISTANT's token and tries what an
assistant must not be able to do (SPEC §2). Every check prints PASS or FAIL
with the reason; the exit code is the number of failures.

    python spec/conformance/check.py https://your-site.example --token <assistant token>

It creates a few clearly marked test items as drafts and asks for one
approval; nothing is ever published by this script (it can't be: that's the
point). Deny or ignore the approval it leaves behind.

Needs: Python 3.11+, httpx.
"""

import argparse
import json
import secrets
import sys
from typing import Any

import httpx

MARK = f"conformance-{secrets.token_hex(4)}"


class Site:
    def __init__(self, base: str, token: str):
        self.base = base.rstrip("/")
        self.http = httpx.Client(timeout=30, follow_redirects=False)
        self.headers = {
            "authorization": f"Bearer {token}",
            "content-type": "application/json",
            "accept": "application/json, text/event-stream",
            "mcp-protocol-version": "2025-06-18",
        }
        self.n = 0

    def rpc(self, method: str, params: dict | None = None, headers: dict | None = None) -> Any:
        self.n += 1
        body = {"jsonrpc": "2.0", "id": self.n, "method": method, "params": params or {}}
        r = self.http.post(f"{self.base}/mcp", json=body, headers=headers or self.headers)
        if r.status_code != 200:
            return {"_status": r.status_code}
        text = r.text
        if not text.lstrip().startswith("{"):  # event stream: take the data line
            text = next((ln[5:] for ln in text.splitlines() if ln.startswith("data:")), "{}")
        return json.loads(text)

    def call(self, tool: str, **args: Any) -> tuple[bool, Any]:
        """(is_error, payload)"""
        out = self.rpc("tools/call", {"name": tool, "arguments": args})
        res = out.get("result", {})
        text = res["content"][0]["text"] if res.get("content") else "{}"
        try:
            payload = json.loads(text)
        except ValueError:
            payload = text
        return bool(res.get("isError")), payload


RESULTS: list[tuple[bool, str, str]] = []


def check(name: str, ok: bool, why: str = "") -> bool:
    RESULTS.append((ok, name, why))
    print(f"{'PASS' if ok else 'FAIL'}  {name}{'' if ok else '  -> ' + why}")
    return ok


def run(site: Site) -> None:
    # Access
    anon = site.rpc("tools/list", headers={k: v for k, v in site.headers.items() if k != "authorization"})
    check("/mcp refuses a request without a token", anon.get("_status") == 401, str(anon)[:120])

    site.rpc(
        "initialize",
        {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "conformance", "version": "0"}},
    )
    tools = site.rpc("tools/list").get("result", {}).get("tools", [])
    names = {t["name"] for t in tools}
    need = {"site_state", "item_create", "item_update", "item_remove", "item_history",
            "item_rollback", "approval_request", "approval_status"}
    check("the spec's tools are all there", need <= names, f"missing {sorted(need - names)}")

    # S1: no way to publish
    sus = [n for n in names if any(w in n for w in ("publish", "approve", "decide", "deploy"))]
    check("S1 no tool can publish or approve", not sus, f"suspicious tools: {sus}")

    # S4: retries are safe
    entry = {"title": f"{MARK} draft", "date": "2026-01-01", "summary": "Conformance test item."}
    e1, a = site.call("item_create", kind="entry", data=entry, idempotency_key=MARK)
    e2, b = site.call("item_create", kind="entry", data=entry, idempotency_key=MARK)
    if not check("item_create works", not e1 and isinstance(a, dict) and "id" in a, str(a)[:200]):
        return
    check("S4 a replayed create returns the same item", not e2 and b.get("id") == a["id"], str(b)[:200])

    # S3: no lost updates
    err, out = site.call("item_update", id=a["id"], version=a["version"] + 5, data={"summary": "x"})
    check("S3 an update from an old version is refused", err and out.get("error") == "version_conflict", str(out)[:200])
    err, out = site.call("item_update", id=a["id"], version=0, data={"summary": "x"})
    check("S3 version 0 is refused cleanly", err and out.get("error") == "version_conflict", str(out)[:200])

    # S8: one error shape
    check("S8 refusals carry `error` and `message`", isinstance(out, dict) and {"error", "message"} <= out.keys(), str(out)[:200])

    # S6: the guard runs on drafts
    secret = {**entry, "title": f"{MARK} guard", "body": "password: hunter2xyz"}
    err, out = site.call("item_create", kind="entry", data=secret)
    check("S6 content that looks like a secret is refused", err and out.get("error") == "content_guard", str(out)[:200])

    # S1/S2: a draft is not public
    pub = site.http.get(f"{site.base}/").text
    check("S1 a draft does not appear on the public site", MARK not in pub)

    # S2: the owner's yes, and only for what they saw
    err, req = site.call("approval_request", ids=[a["id"]], note=f"{MARK}: please deny")
    if not check("approval_request returns a review link", not err and "review_url" in req, str(req)[:200]):
        return
    page = site.http.get(req["review_url"])
    check(
        "S2 the review page needs the owner (not open to the assistant)",
        page.status_code in (302, 303, 401, 403) or "passkey" in page.text.lower() and "Approve" not in page.text,
        f"status {page.status_code}",
    )
    form = site.http.post(req["review_url"], data={"d_" + a["id"]: "approve"})
    after = site.http.get(f"{site.base}/").text
    check("S1 posting a decision without the owner publishes nothing", MARK not in after, f"status {form.status_code}")

    err, cur = site.call("site_state")
    item = next((i for i in cur.get("items", []) if i["id"] == a["id"]), None)
    err, upd = site.call("item_update", id=a["id"], version=item["version"], data={"summary": "Edited after asking."})
    err, st = site.call("approval_status", approval_id=req["id"])
    mine = next((i for i in st.get("items", []) if i["id"] == a["id"]), {})
    check("S2 editing after asking voids the request for that item", mine.get("status") == "superseded", str(mine)[:200])

    # S5: nothing is lost
    err, hist = site.call("item_history", id=a["id"])
    versions = hist.get("versions") or hist.get("items") or []
    check("S5 every version is kept", len(versions) >= 2, str(hist)[:200])
    err, rb = site.call("item_rollback", id=a["id"], to_version=1, version=upd["version"])
    check("S5 rollback stages an earlier version", not err and rb.get("version") == upd["version"] + 1, str(rb)[:200])

    # S7: an image on someone else's host is copied in or refused, never kept as a link
    far = "https://example.com/conformance-hotlink.jpg"
    err, hot = site.call(
        "item_create",
        kind="entry",
        data={**entry, "title": f"{MARK} hotlink", "body": f"![a test picture]({far})"},
        idempotency_key=f"{MARK}-hotlink",
    )
    kept = not err and far in json.dumps(hot)
    check("S7 an outside image is copied in or refused, never linked", not kept, str(hot)[:200])
    if not err and isinstance(hot, dict) and "id" in hot:
        site.call("item_remove", id=hot["id"], version=hot["version"], reason="conformance cleanup")

    # Clean up: remove the test item (a staged removal; never published).
    site.call("item_remove", id=a["id"], version=rb.get("version", upd["version"]), reason="conformance cleanup")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("site", help="the site's address, e.g. https://example.com")
    ap.add_argument("--token", required=True, help="an assistant's OAuth access token for this site")
    args = ap.parse_args()
    run(Site(args.site, args.token))
    failed = sum(1 for ok, _, _ in RESULTS if not ok)
    print(f"\n{len(RESULTS) - failed} passed, {failed} failed")
    return failed


if __name__ == "__main__":
    sys.exit(main())
