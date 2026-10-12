"""A refusal inside an owner page (an unknown id, a link that's used up, a
bad request) is the owner's page with the refusal's status, never a 500.
Port of cloudflare/test/owner-refusals.test.ts."""

import re

from .web import signed_in

ERROR_PAGE = "<title>Problem</title>"
ERROR_H1 = "<h1>Something's wrong</h1>"


def csrf_of(page: str) -> str:
    return re.search(r'name="csrf" value="([^"]+)"', page).group(1)


async def test_shows_the_error_page_with_the_refusals_status_for_every_owner_route_given_an_unknown_id(db, http):  # fmt: skip
    cookies = await signed_in(db)
    csrf = csrf_of((await http.get("/review/passkeys", cookies=cookies)).text)
    cases = [
        ("GET", "/review/req_unknown00", None),
        ("POST", "/review/req_unknown00", {"csrf": csrf, "all": "approve"}),
        ("POST", "/review/req_unknown00", {"csrf": "stale"}),
        ("GET", "/review/req_unknown00/preview", None),
        ("GET", "/review/history/999", None),
        ("POST", "/review/history/999", {"csrf": csrf, "note": ""}),
        ("POST", "/review/history/999", {"csrf": "stale"}),
        ("GET", "/review/write/en_deadbeef", None),
        (
            "POST",
            "/review/write/en_deadbeef",
            {"csrf": csrf, "action": "save", "title": "x", "date": "2026-10-01"},
        ),
        ("GET", "/review/write/en_deadbeef/preview", None),
    ]
    for method, path, fields in cases:
        r = await http.request(method, path, data=fields, cookies=cookies)
        assert (method, path, r.status_code) == (method, path, 404)
        assert ERROR_PAGE in r.text
        assert ERROR_H1 in r.text


async def test_answers_a_used_up_link_with_the_link_page_and_410(db, http):
    for path in ("/upload/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "/passkey/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"):  # fmt: skip
        r = await http.get(path)
        assert (path, r.status_code) == (path, 410)
        assert "<title>Link used</title>" in r.text
        assert "<h1>This link has been used or has expired</h1>" in r.text
    sent = await http.post("/upload/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", data={"alt": "x"})
    assert sent.status_code == 410
    assert "<title>Link used</title>" in sent.text


async def test_answers_a_bad_connect_request_with_the_cant_connect_page_and_400(db, http):
    cookies = await signed_in(db)
    r = await http.get("/authorize?response_type=code", cookies=cookies)
    assert r.status_code == 400
    assert "<title>Can&#39;t connect</title>" in r.text
