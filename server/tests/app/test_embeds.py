import json
from pathlib import Path

import pytest

from server.app import approvals, content
from server.spec.embed_review import embed_review
from server.spec.embed_url import embed_sources, embed_url
from server.spec.embeds import body_markdown, embed_notes, embeds_of, finish_embeds, frame_csp
from server.spec.html import markdown

from .web import signed_in

CASES = json.loads((Path(__file__).parents[3] / "spec/embed-cases.json").read_text())
SOURCE = "https://www.youtube-nocookie.com"
FORM = "!embed[Tour](https://youtu.be/Ab_C-123)"
ORIGIN = "https://site.example"


@pytest.fixture(autouse=True)
async def clean_content(db):
    await db.execute("TRUNCATE site_embed_sources, approvals, publishes, live, revisions, items, idempotency")


def test_canonicalisation_and_rejection_list():
    for value, expected in CASES["valid"]:
        assert embed_url(value, True).origin == expected
    for value in CASES["invalid"] + [
        "https://" + ".".join(map(str, v)) for v in CASES["invalid_ipv4"]
    ]:
        with pytest.raises((ValueError, UnicodeError)):
            embed_url(value, True)
    for value, expected in CASES["providers"]:
        assert embed_url(value).href == expected
    with pytest.raises(ValueError):
        embed_sources(["https://example.com", "https://EXAMPLE.com:443/"])
    with pytest.raises(ValueError):
        embed_sources([SOURCE] * 21)


def test_literal_cases_and_rendered_budget():
    for src in [
        "```\n" + FORM + "\n```",
        "~~~\n" + FORM + "\n~~~",
        "    " + FORM,
        "`" + FORM + "`",
        "\\" + FORM,
        "> " + FORM,
        "- " + FORM,
        "inline " + FORM,
        FORM + " ",
        "!embed[x](javascript:bad)",
    ]:
        assert embeds_of(src) == []
        html = finish_embeds(body_markdown(src), [SOURCE], ORIGIN)
        assert "<iframe" not in html and "<a " not in html and "<img" not in html
    for src in ["Plain **bold**\n\ntext.", "![photo](/media/hash.png)", "<iframe src=x>"]:
        assert body_markdown(src) == markdown(src)
    body = body_markdown("Before\n" + FORM + "\nAfter")
    assert body.index("Before") < body.index("<porchsite-embed") < body.index("After")
    assert finish_embeds(body_markdown(FORM), [SOURCE], ORIGIN) == CASES["frame"]
    marker = body_markdown(FORM)
    result = finish_embeds(
        "<template>" + marker + "</template>" + marker * 14, [SOURCE], ORIGIN, marker
    )
    assert result.count("<iframe ") == 12 and result.count("<a ") == 15
    assert "<iframe" not in finish_embeds(marker, [SOURCE], SOURCE)
    assert "<iframe" not in finish_embeds(marker)
    assert frame_csp("default-src 'none'", [], ORIGIN) == "default-src 'none'"
    assert (
        frame_csp("default-src 'none'", [SOURCE], ORIGIN)
        == "default-src 'none'; frame-src " + SOURCE
    )


def test_review_text_and_notes():
    live = [
        {"id": "site", "kind": "site", "data": {"embed_sources": []}},
        {"id": "e", "kind": "entry", "data": {"body": FORM, "status": "ready"}},
    ]
    proposed = [
        {**r, "data": {"embed_sources": [SOURCE]}} if r["kind"] == "site" else r for r in live
    ]
    assert "You are approving the whole source" in embed_review(live, proposed, proposed, ORIGIN)
    assert "Its players become normal links" in embed_review(proposed, live, live, ORIGIN)
    assert "bücher.example" in embed_review(
        live,
        [
            {
                "id": "site",
                "kind": "site",
                "data": {"embed_sources": ["https://xn--bcher-kva.example"]},
            }
        ],
        [],
        ORIGIN,
    )
    assert len(embed_notes([{"id": "e", "body": FORM + "\n" + FORM}], [], ORIGIN)) == 2
    assert embed_notes([{"id": "e", "body": FORM}], [SOURCE], ORIGIN) == []


async def _make(db, kind, data):
    return await content.create_item(db, "assistant:test", kind, data, None)


async def _publish(db, items):
    a = await approvals.request(db, "assistant:test", [i["id"] for i in items], "")
    await approvals.decide(
        db, a["id"], {i["id"]: {"decision": "approve"} for i in items}, "", ORIGIN
    )


async def test_actual_approval_publication_review_and_removal(db, http):
    s = await _make(db, "site", {"theme": "personal-homepage", "embed_sources": [SOURCE]})
    e = await _make(db, "entry", {"title": "Tour", "date": "2026-10-15", "body": FORM})
    await _publish(db, [e])
    page = await http.get("/journal/" + e["slug"] + "/")
    assert "<iframe" not in page.text and "frame-src" not in page.headers["content-security-policy"]
    a = await approvals.request(db, "assistant:test", [s["id"]], "")
    http.cookies.update(await signed_in(db))
    review = await http.get("/review/" + a["id"])
    assert (
        "Add embed source" in review.text and SOURCE in review.text and "<iframe" not in review.text
    )
    assert (
        "frame-src" not in review.headers["content-security-policy"]
        and review.headers["x-frame-options"] == "DENY"
    )
    preview = await http.get("/review/" + a["id"] + "/preview/journal/" + e["slug"] + "/")
    assert "<iframe" not in preview.text
    await approvals.decide(db, a["id"], {"site": {"decision": "approve"}}, "", ORIGIN)
    page = await http.get("/journal/" + e["slug"] + "/")
    assert (
        "<iframe" in page.text and "frame-src " + SOURCE in page.headers["content-security-policy"]
    )
    assert "geolocation=()" in page.headers["permissions-policy"]
    preview = await http.get("/review/" + a["id"] + "/preview/journal/" + e["slug"] + "/")
    assert "<iframe" not in preview.text
    publish_id = await db.fetchval("SELECT MAX(id) FROM publishes")
    changed = await content.update_item(
        db, "assistant:test", s["id"], s["version"], {"embed_sources": []}
    )
    await _publish(db, [changed])
    page = await http.get("/journal/" + e["slug"] + "/")
    assert "<iframe" not in page.text and "frame-src" not in page.headers["content-security-policy"]
    restored = await http.get("/review/history/" + str(publish_id))
    assert "Add embed source" in restored.text and "<iframe" not in restored.text
    from server.app import history

    await history.revert(db, publish_id, "restore source", ORIGIN)
    assert "<iframe" in (await http.get("/journal/" + e["slug"] + "/")).text


async def test_self_origin_refused_before_publication(db):
    s = await _make(db, "site", {"embed_sources": [ORIGIN]})
    a = await approvals.request(db, "assistant:test", [s["id"]], "")
    with pytest.raises(Exception, match="own origin"):
        await approvals.decide(db, a["id"], {"site": {"decision": "approve"}}, "", ORIGIN)
    assert await db.fetchrow("SELECT * FROM live WHERE item_id='site'") is None


async def test_mcp_check_notes_use_live_authority(db, http):
    from .test_web_mcp import assistant

    client = await assistant(db, http)
    err, plain, _ = await client.call("site_check")
    assert not err and "embed_notes" not in plain
    await _make(
        db, "entry", {"title": "Literal code", "date": "2026-10-15", "body": "``\n" + FORM + "\n``"}
    )
    err, literal, _ = await client.call("site_check")
    assert not err and "embed_notes" not in literal
    s = await _make(db, "site", {"embed_sources": [SOURCE]})
    e = await _make(db, "entry", {"title": "Video", "date": "2026-10-15", "body": FORM})
    err, quick, _ = await client.call("site_check")
    assert not err and quick["ok"] and quick["broken"] == []
    assert quick["embed_notes"] == [
        {
            "id": e["id"],
            "url": SOURCE + "/embed/Ab_C-123",
            "origin": SOURCE,
            "note": "Ask the owner to approve this embed source.",
        }
    ]
    err, deep, _ = await client.call("site_check", deep=True)
    assert not err and deep["embed_notes"] == quick["embed_notes"]
    await _publish(db, [s, e])
    err, done, _ = await client.call("site_check")
    assert not err and "embed_notes" not in done


def test_authored_frames_and_dynamic_tag_names_are_not_trusted():
    from server.app import themecheck, themes

    marker = body_markdown(FORM)
    assert (
        finish_embeds(
            '<iframe src="' + SOURCE + '">ignored</iframe>' + marker, [SOURCE], ORIGIN, marker
        )
        == '<a href="' + SOURCE + '/">' + SOURCE + "/</a>ignored " + CASES["frame"]
    )
    assert (
        "iframe"
        not in finish_embeds('<IFRAME src="' + SOURCE + '"></IFRAME>', [SOURCE], ORIGIN).lower()
    )
    assert (
        "iframe"
        not in finish_embeds(
            '<!--><iframe src="' + SOURCE + '"></iframe>', [SOURCE], ORIGIN
        ).lower()
    )
    t = themes.built_in()["personal-homepage"]
    for bad in [
        '<{{site.logo_text}} src="{{site.cta_link}}"></{{site.logo_text}}>',
        '<porchsite-embed data-url="x" data-title="y"></porchsite-embed>',
    ]:
        probs = themecheck.rules(
            "personal-homepage", {**t, "pages": {**t["pages"], "home": bad}}, scripts=True
        )
        assert any("tag names" in p or "iframes" in p for p in probs)


def test_matched_multiline_inline_code_remains_literal():
    for ticks in ["`", "``"]:
        for prefix in ["", "Before **text** "]:
            src = prefix + ticks + "\n" + FORM + "\n" + ticks
            assert embeds_of(src) == []
            assert body_markdown(src) == markdown(src)
            assert "<iframe" not in finish_embeds(body_markdown(src), [SOURCE], ORIGIN)
            assert embed_notes([{"id": "e", "body": src}], [], ORIGIN) == []
    adjacent = "`\n" + FORM + "\n`\n" + FORM
    assert len(embeds_of(adjacent)) == 1
    assert finish_embeds(body_markdown(adjacent), [SOURCE], ORIGIN).count("<iframe ") == 1
    assert len(embeds_of("Unmatched `\n" + FORM)) == 1
    assert len(embeds_of("Escaped \\`\n" + FORM + "\n`")) == 1


def test_noscript_fallback_does_not_spend_frame_budget():
    marker = body_markdown(FORM)
    body = "<noscript>" + marker * 12 + "</noscript>" + marker
    finished = finish_embeds(body, [SOURCE], ORIGIN, marker)
    assert finished.count("<iframe ") == 1 and finished.count("<a ") == 13
    assert "<iframe" not in finished.split("</noscript>")[0]
    for src in ["> `\n" + FORM + "\n`", "- ``\n" + FORM + "\n``"]:
        assert embeds_of(src) == [] and body_markdown(src) == markdown(src)


def test_literal_tags_allow_conditional_attributes():
    from server.app import themecheck, themes

    for name, look in themes.built_in().items():
        assert themecheck.rules(name, look, scripts=True) == []
    look = themes.built_in()["personal-homepage"]
    adjacent = '<a{{#site.title}} id="x"{{/site.title}}{{#site.handle}} class="x"{{/site.handle}}>{{site.title}}</a>'
    assert (
        themecheck.rules(
            "personal-homepage",
            {**look, "pages": {**look["pages"], "home": adjacent}},
            scripts=True,
        )
        == []
    )
    for home in [
        '<a{{#site.title}} id="{{site.title}}"{{/site.title}} href="/">{{site.title}}</a>',
        '<tr{{^site.title}} class="today"{{/site.title}}><td {{site.title}}>{{site.title}}</td></tr>',
        '<a {{#site.title}}id="{{site.title}}"{{/site.title}}>{{site.title}}</a>',
    ]:
        assert (
            themecheck.rules(
                "personal-homepage",
                {**look, "pages": {**look["pages"], "home": home}},
                scripts=True,
            )
            == []
        )
    for home in [
        "<{{site.title}}>",
        "</{{site.title}}>",
        "<iframe></iframe>",
        "<object></object>",
        "<embed>",
    ]:
        probs = themecheck.rules(
            "personal-homepage", {**look, "pages": {**look["pages"], "home": home}}, scripts=True
        )
        assert any("tag names" in p or "iframes" in p for p in probs), home


def test_rendered_output_neutralises_assembled_elements_and_forged_markers():
    from server.app.theme import render

    marker = body_markdown(FORM)
    for home in [
        '<if{{#site.handle}} {{#site.handle}}x{{/site.handle}} {{/site.handle}}rame src="https://example.com/player">Text</iframe>',
        "<if{{#flag}}rame{{/flag}}>Text</iframe>",
        '<ob{{part}}ject data="https://example.com/player">Text</object>',
        '<em{{part}}bed src="https://example.com/player">',
        '<fr{{part}}ame src="https://example.com/player">',
        '<!--><IFRAME src="https://example.com/player">Text</iframe>',
        '<porchsite-embed data-url="https%3A%2F%2Fwww.youtube-nocookie.com%2Fembed%2FAb_C-123" data-title="Tour"></porchsite-embed>',
        '<porchsite-embed data-key="00000000-0000-0000-0000-000000000000"></porchsite-embed>',
    ]:
        html = render(
            {"pages": {"home": home}, "partials": {}},
            "home",
            {"site": {"handle": False}, "flag": True, "part": ""},
            {"sources": [SOURCE], "origin": ORIGIN},
        )
        assert not any(
            "<" + name in html.lower() for name in ["iframe", "object", "embed", "frame"]
        ), home
    assert (
        render(
            {"pages": {"home": "{{{body}}}"}, "partials": {}},
            "home",
            {"body": marker},
            {"sources": [SOURCE], "origin": ORIGIN},
        )
        == CASES["frame"]
    )
    assert "<iframe" not in finish_embeds(str(marker), [SOURCE], ORIGIN)
    assert "<iframe" not in render(
        {"pages": {"home": "{{{body}}}"}, "partials": {}},
        "home",
        json.loads(json.dumps({"body": marker})),
        {"sources": [SOURCE], "origin": ORIGIN},
    )
    mixed = render(
        {
            "pages": {"home": '<if{{part}}rame src="' + SOURCE + '"></iframe>{{{body}}}'},
            "partials": {},
        },
        "home",
        {"part": "", "body": marker},
        {"sources": [SOURCE], "origin": ORIGIN},
    )
    assert mixed.count("<iframe ") == 1
