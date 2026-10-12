"""Theme requests and shared looks, the site's side: a site files one, the
queue checks it came from that site, a curator answers it, the site sees the
answer. Port of the service parts of cloudflare/test/requests.test.ts; the
queue (cloudflare/downloads/board) is a fake here that keeps the board's
answers and asks the site for its proof as the board does."""

import json
import secrets
from urllib.parse import parse_qs, urlsplit

import pytest

from server.app import requests, themecheck, themes
from server.app.errors import ApiError
from server.spec.theme import THEMES as THEMES_DIR

from .fakes import json_response

who = "assistant:test"
ORIGIN = "https://bakery.example"


class FakeQueue:
    def __init__(self, db):
        self.db = db
        self.requests: dict[str, dict] = {}
        self.groups: dict[str, dict] = {}
        self.submissions: dict[str, dict] = {}

    async def proven(self, body) -> bool:
        # The board fetches <origin>/.well-known/sitekeeper-proof/<nonce>; the site answers with this.
        return await requests.answer_proof(self.db, str(body.get("nonce", "")))

    async def __call__(self, url, method="GET", headers=None, content=None):
        u = urlsplit(url)
        assert f"{u.scheme}://{u.netloc}" == requests.QUEUE
        ids = [x for x in parse_qs(u.query).get("ids", [""])[0].split(",") if x]
        if u.path == "/requests" and method == "POST":
            body = json.loads(content)
            if not await self.proven(body):
                return json_response(
                    {"error": "not_proven", "message": "The site didn't confirm this request."}, 403
                )
            id = f"req_{secrets.token_hex(4)}"
            self.requests[id] = {
                "id": id,
                "title": body["title"],
                "origin": body["origin"],
                "state": "new",
                "group": None,
            }
            return json_response({"id": id, "status": "open"}, 201)
        if u.path == "/requests/status" and method == "GET":
            out = []
            for id in ids:
                r = self.requests.get(id)
                if r:
                    g = self.groups.get(r["group"] or "", {})
                    answered = g.get("status") == "answered"
                    out.append(
                        {
                            "id": id,
                            "status": "answered" if answered else "open",
                            "theme": g.get("theme", "") if answered else "",
                        }
                    )
            return json_response({"requests": out})
        if u.path == "/submissions" and method == "POST":
            body = json.loads(content)
            if not await self.proven(body):
                return json_response(
                    {"error": "not_proven", "message": "The site didn't confirm this request."}, 403
                )
            pkg = json.loads(body["package"])
            name = pkg["manifest"]["name"]
            problems = themecheck.check(name, pkg, pkg.get("sample"), scripts=False)
            if problems:
                return json_response(
                    {"error": "theme_problems", "message": "; ".join(problems)}, 422
                )
            claimed = body.get("author_x") or pkg["manifest"].get("author_x") or ""
            if claimed and not themecheck.X_HANDLE.search(str(claimed)):
                return json_response({"error": "bad_author_x", "message": "author_x is an X handle."}, 400)  # fmt: skip
            id = f"sub_{secrets.token_hex(4)}"
            code = secrets.token_hex(4).upper() if claimed else ""
            self.submissions[id] = {
                "id": id,
                "name": name,
                "package": pkg,
                "state": "new",
                "note": "",
                "author_x": claimed,
                "claim_code": code,
                # As the board answers: waiting until the curator checks a claim.
                "credit": "waiting" if claimed else "",
            }
            out = {"id": id, "status": "new"}
            if claimed:
                out["credit"] = {
                    "author_x": claimed,
                    "claim_code": code,
                    "instructions": f"To be credited, post this from @{claimed} on X: 'Porchsite look {name}: {code}'. The curator checks it before the look is published with your name; until then it is published without credit.",  # fmt: skip
                }
            return json_response(out, 201)
        if u.path == "/submissions/status" and method == "GET":
            out = []
            for id in ids:
                s = self.submissions.get(id)
                if s:
                    out.append(
                        {
                            "id": id,
                            "status": s["state"],
                            "note": s["note"] if s["state"] in ("rejected", "published") else "",
                            **({"credit": s["credit"]} if s.get("credit") else {}),
                        }
                    )
            return json_response({"submissions": out})
        return json_response({}, 404)

    # The curator's side.
    def queue(self):
        return [{"id": r["id"], "title": r["title"]} for r in self.requests.values()]

    def group(self, id, name):
        self.requests[id].update(state="grouped", group=name)
        self.groups.setdefault(name, {"status": "open", "theme": ""})

    def answer(self, name, theme):
        self.groups[name] = {"status": "answered", "theme": theme}

    def reject(self, id, note):
        self.submissions[id].update(state="rejected", note=note)


async def test_files_privately_gets_answered_and_the_site_hears(db):
    q = FakeQueue(db)
    filed = await requests.file(
        db,
        ORIGIN,
        who,
        {
            "type": "business",
            "title": "Bakery with hours",
            "description": "Opening hours, a weekly specials list.",
            "examples": [],
        },
        q,
    )
    assert filed["status"] == "open"
    # Only the curator sees the words, and never where they came from.
    assert "Bakery with hours" in [r["title"] for r in q.queue()]
    assert "origin" not in q.queue()[0]
    q.group(filed["id"], "small-business-hours")
    mine = (await requests.mine(db, q))[0]
    assert (mine["id"], mine["status"]) == (filed["id"], "open")
    q.answer("small-business-hours", "shopfront")
    mine = (await requests.mine(db, q))[0]
    assert (mine["id"], mine["status"], mine["theme"]) == (filed["id"], "answered", "shopfront")
    assert mine["title"] == "Bakery with hours"


async def test_shares_a_look_this_site_made_reviewed_by_the_curator(db):
    q = FakeQueue(db)
    sample = json.loads((THEMES_DIR / "product-page" / "sample.json").read_bytes().decode("utf-8"))
    b = themes.built_in()["product-page"]

    async def empty_catalog(url, method="GET", headers=None, content=None):
        return json_response({"themes": []})

    await themes.create(
        db,
        {
            "manifest": {**b["manifest"], "name": "tea-house"},
            "sample": sample,
            "pages": b["pages"],
            "partials": b["partials"],
            "css": b["static"]["site.css"],
        },
        who,
        empty_catalog,
    )
    s = await requests.submit(
        db, ORIGIN, who, "tea-house", "For tea rooms: a menu-led front page.", q
    )
    assert s["status"] == "new"
    assert "tea-house" in [x["name"] for x in q.submissions.values()]
    assert q.submissions[s["id"]]["package"]["manifest"]["name"] == "tea-house"
    q.reject(s["id"], "Too close to product-page.")
    got = (await requests.my_submissions(db, q))[0]
    assert (got["name"], got["status"], got["note"]) == (
        "tea-house",
        "rejected",
        "Too close to product-page.",
    )
    # Only the site's own looks can be shared.
    with pytest.raises(ApiError) as e:
        await requests.submit(db, ORIGIN, who, "product-page", "x" * 20, q)
    assert e.value.code == "no_such_look"


async def test_refuses_a_request_the_site_didnt_send(db):
    q = FakeQueue(db)
    r = await q(
        f"{requests.QUEUE}/requests",
        method="POST",
        content=json.dumps(
            {
                "origin": f"{ORIGIN}/",
                "nonce": "x" * 24,
                "type": "business",
                "title": "Spam",
                "description": "Buy things now please",
            }
        ),
    )
    assert r.status_code == 403
    assert r.json()["error"] == "not_proven"


async def test_a_proof_answers_once_and_a_refusal_comes_back_as_the_queues(db):
    nonce = await requests._new_proof(db)
    assert await requests.answer_proof(db, nonce) is True
    assert await requests.answer_proof(db, nonce) is False

    async def stolen(url, method="GET", headers=None, content=None):
        await requests.answer_proof(db, json.loads(content)["nonce"])  # someone else used it first
        return await FakeQueue(db)(url, method, headers, content)

    with pytest.raises(ApiError) as e:
        await requests.file(
            db, ORIGIN, who, {"type": "x", "title": "t", "description": "d", "examples": []}, stolen
        )
    assert (e.value.status, e.value.code) == (502, "not_proven")


async def test_queue_down(db):
    async def down(url, method="GET", headers=None, content=None):
        raise OSError("no route")

    with pytest.raises(ApiError) as e:
        await requests.file(
            db, ORIGIN, who, {"type": "x", "title": "t", "description": "d", "examples": []}, down
        )
    assert e.value.code == "queue_unreachable"
    # Requests filed earlier read "unknown" while the queue is down.
    assert all(r["status"] == "unknown" for r in await requests.mine(db, down))
