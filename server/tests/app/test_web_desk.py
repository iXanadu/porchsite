"""The owner's writing desk (spec §5): the owner writes and publishes
directly, through the same safety rules. Port of cloudflare/test/desk.test.ts."""

import json
import re

from server.app import approvals, content

from .web import signed_in, who


def csrf_of(page: str) -> str:
    return re.search(r'name="csrf" value="([^"]+)"', page).group(1)


async def test_is_the_owners_only(db, http):
    r = await http.get("/review/write")
    assert r.status_code == 303
    sneaky = await http.post("/review/write/new", data={"title": "Sneaky", "date": "2026-10-01", "action": "publish"})  # fmt: skip
    assert sneaky.status_code == 303
    assert len(await content.all_items(db)) == 0


async def test_writes_a_draft_previews_it_and_publishes_it_at_once(db, http):
    s = await content.create_item(db, who, "site", {"title": "Kettle", "streams": [{"id": "journal", "title": "Journal"}, {"id": "letters", "title": "Notes"}]}, None)  # fmt: skip
    r = await approvals.request(db, who, [s["id"]], "")
    await approvals.decide(db, r["id"], {s["id"]: {"decision": "approve"}}, "")
    cookies = await signed_in(db)
    blank = (await http.get("/review/write/new", cookies=cookies)).text
    assert "<h1>Write something new</h1>" in blank
    assert '<option value="journal" selected>Journal</option><option value="letters">Notes</option>' in blank  # fmt: skip
    assert "Save as a draft" in blank
    saved = await http.post("/review/write/new", data={"csrf": csrf_of(blank), "stream": "letters", "title": "Dear reader", "summary": "A first letter.", "date": "2026-10-05", "tags": "tea, mornings", "body": "Hello.\r\n\r\nMore soon.", "action": "save"}, cookies=cookies)  # fmt: skip
    assert saved.status_code == 303
    id = re.search(r"/review/write/(ent_[0-9a-f]+)\?saved=1$", saved.headers["location"]).group(1)
    item = await content.get_item(db, id)
    assert {k: item["data"][k] for k in ("stream", "title", "status", "tags", "body")} == {"stream": "letters", "title": "Dear reader", "status": "draft", "tags": ["tea", "mornings"], "body": "Hello.\n\nMore soon."}  # fmt: skip
    assert (await content.history(db, id))[0]["actor"] == "owner"
    edit = (await http.get(f"/review/write/{id}?saved=1", cookies=cookies)).text
    assert '<span class="tag">draft</span>' in edit
    assert '<p class="ok">Saved.</p>' in edit
    assert '<option value="letters" selected>Notes</option>' in edit
    # The preview shows the draft as its page; the public site doesn't have it.
    preview = (await http.get(f"/review/write/{id}/preview", cookies=cookies)).text
    assert "Preview: not live until you publish." in preview
    assert "<h1>Dear reader</h1>" in preview
    assert (await http.get(f"/letters/{item['slug']}/")).status_code == 404
    done = await http.post(f"/review/write/{id}", data={"csrf": csrf_of(edit), "version": str(item["version"]), "stream": "letters", "title": "Dear reader", "summary": "A first letter.", "date": "2026-10-05", "tags": "tea mornings", "body": "Hello.\n\nMore soon.", "action": "publish"}, cookies=cookies)  # fmt: skip
    assert done.status_code == 303
    assert done.headers["location"] == f"https://site.example/review/write?published={id}"
    assert "Dear reader" in (await http.get(f"/letters/{item['slug']}/")).text
    pub = await db.fetchrow("SELECT actor, approval_id, items, note FROM publishes ORDER BY id DESC LIMIT 1")  # fmt: skip
    assert (pub["actor"], pub["approval_id"], pub["note"]) == ("owner", None, "published by the owner from the writing desk")  # fmt: skip
    # Saved (version 2), marked ready (3), published at exactly that version.
    assert json.loads(pub["items"]) == [{"id": id, "version": item["version"] + 2}]
    index = (await http.get(f"/review/write?published={id}", cookies=cookies)).text
    assert '<p class="ok">Published. It\'s live on the site.</p>' in index
    assert '<span class="tag">live</span><h2 style="margin-top:8px">Dear reader</h2><div class="meta">2026-10-05 · Notes #tea #mornings</div>' in index  # fmt: skip


async def test_shows_the_assistants_drafts_for_the_owner_to_finish(db, http):
    a = await content.create_item(db, who, "entry", {"title": "From the assistant", "date": "2026-10-06", "summary": "Ready.", "status": "ready"}, None)  # fmt: skip
    req = await approvals.request(db, who, [a["id"]], "")
    d = await content.create_item(db, who, "entry", {"title": "Half done", "date": "2026-10-07", "status": "draft"}, None)  # fmt: skip
    cookies = await signed_in(db)
    index = (await http.get("/review/write", cookies=cookies)).text
    assert '<span class="tag">draft</span><h2 style="margin-top:8px">Half done</h2>' in index
    assert '<span class="tag">ready, not live</span><h2 style="margin-top:8px">From the assistant</h2>' in index  # fmt: skip
    assert index.index("Half done") < index.index("From the assistant")
    edit = (await http.get(f"/review/write/{a['id']}", cookies=cookies)).text
    done = await http.post(f"/review/write/{a['id']}", data={"csrf": csrf_of(edit), "version": str(a["version"]), "stream": "", "title": "From the assistant", "summary": "Ready.", "date": "2026-10-06", "tags": "", "body": "", "action": "publish"}, cookies=cookies)  # fmt: skip
    assert done.status_code == 303
    now = await content.get_item(db, a["id"])
    assert (
        await db.fetchval("SELECT version FROM live WHERE item_id = $1", a["id"]) == now["version"]
    )
    assert (await approvals.get(db, req["id"]))["items"][0]["status"] == "superseded"
    assert d["version"] == 1
    # The owner publishing the very version a request names settles the request.
    b = await content.create_item(db, who, "entry", {"title": "Asked for", "date": "2026-10-06"}, None)  # fmt: skip
    asked = await approvals.request(db, who, [b["id"]], "")
    assert await approvals.publish_now(db, [{"id": b["id"], "version": b["version"]}], "") == [b["id"]]  # fmt: skip
    got = await approvals.get(db, asked["id"])
    assert got["items"][0]["status"] == "published"
    assert got["status"] == "decided"


async def test_refuses_a_stale_form_an_old_version_and_guarded_text_keeping_what_was_typed(
    db, http
):
    cookies = await signed_in(db)
    item = next(i for i in await content.all_items(db) if i["data"].get("title") == "Half done")
    edit = (await http.get(f"/review/write/{item['id']}", cookies=cookies)).text
    fields = {"version": str(item["version"]), "stream": "", "title": "Half done", "summary": "", "date": "2026-10-07", "tags": "", "body": "Still writing.", "action": "save"}  # fmt: skip
    stale = await http.post(f"/review/write/{item['id']}", data={**fields, "csrf": "nope"}, cookies=cookies)  # fmt: skip
    assert stale.status_code == 403
    assert "This form expired. Try again." in stale.text
    await content.update_item(db, who, item["id"], item["version"], {"summary": "The assistant got here first."})  # fmt: skip
    old = await http.post(f"/review/write/{item['id']}", data={**fields, "csrf": csrf_of(edit)}, cookies=cookies)  # fmt: skip
    assert old.status_code == 409
    assert "This entry changed since you opened it" in old.text
    assert ">Still writing.</textarea>" in old.text
    fresh = await content.get_item(db, item["id"])
    guarded = await http.post(f"/review/write/{item['id']}", data={**fields, "version": str(fresh["version"]), "body": "password: hunter2hunter2", "csrf": csrf_of(edit)}, cookies=cookies)  # fmt: skip
    assert guarded.status_code == 422
    assert "This looks like it contains a password." in guarded.text
    bad = await http.post(f"/review/write/{item['id']}", data={**fields, "version": str(fresh["version"]), "date": "soon", "csrf": csrf_of(edit)}, cookies=cookies)  # fmt: skip
    assert "date: must be a date written YYYY-MM-DD" in bad.text
    assert (await content.get_item(db, item["id"]))["version"] == fresh["version"]
