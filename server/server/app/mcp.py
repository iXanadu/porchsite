"""The assistant's tools (SPEC §4), served at /mcp over streamable HTTP. Every
tool goes through content.py and approvals.py; none of them can publish (S1).
Port of cloudflare/src/mcp.ts on the mcp SDK's low-level server, so each
tool's name, description and input schema are exactly the Cloudflare
edition's (tests compare them with tests/app/cloudflare_tools.json), and its
arguments are checked the way zod checks them, with the same messages.

Who is calling comes from the access token (main.py puts its props on the
request): {client, clientId, origin}.
"""

import base64
import binascii
import logging
import re
from collections.abc import Awaitable, Callable
from typing import Any
from urllib.parse import urlsplit

import mcp_types as types
from mcp.server.lowlevel.server import NotificationOptions, Server
from mcp.shared.exceptions import MCPError

from . import analytics, approvals, check, content, media, requests, site, themes, updates, uploads
from .db import Db, dumps
from .errors import ApiError
from .fields import field_guide, kind_guide
from .home import HOME

log = logging.getLogger(__name__)

INSTRUCTIONS = """You keep this person's website up to date. The site is theirs:
nothing you write is public until they approve it, and the site enforces that.
Workflow: site_state (see what exists, each item's version and field guide) ->
item_create / item_update / item_remove (images: an https link, or
photo_upload_link for a photo your person sent you) -> approval_request (only the ids you
changed for this request; site_check first) -> give the owner the review_url -> approval_status.
Finish the whole job first and send it as one request, then tell your person at once:
your drafts are invisible to them until you do.
Never put passwords, keys, tokens or private addresses in content; the site refuses them.
The look: theme_list (what's installed, and the catalog to choose from, with previews) ->
theme_install -> set the site item's theme -> theme_needs (the art and words that theme
wants, and which are missing) -> fill them -> one approval_request.
Cards have a visibility: a private card is never shown and its name may not appear in
anything public (the site refuses it); a mention card shows its name and description only,
and an entry names it at most once in its summary and once in its body.
site_stats: who reads the site."""

NEXT = (
    "When your changes are ready, call site_check, then approval_request with the ids you changed."
)
IMAGE_ADD_DESCRIPTION = "For a picture you hold as a file (one you made, or one sent to you) when you can't send it to a photo_upload_link: send its bytes here, base64-encoded (JPEG, PNG or WebP, up to 8 MB). Returns `image` (a /media path) with its pixel `width` and `height`. Put `image` in an image field (hero, cover, a card's image, or ![what it shows](image) in a body) with a description in its alt field. Nothing shows publicly until the owner approves an item that uses it."
CHECK_DESCRIPTION = (
    "Look over the site as it will be once everything you've changed is published, the way a visitor"
    " clicks through it: `broken`, links inside the site that lead nowhere (a page, a section of the home"
    " page, a picture), each with where it is and why; and `empty_sections`, sections in the site's layout"
    " with nothing in them (the menu leaves them out; take them out of the site's sections, or fill them,"
    " if you mean to). `unreachable` lists entries with no rendered link path from the home page, each with id and why. `ok` is true when broken and unreachable are both empty. Run it before you ask for approval and before"
    " you tell your person the site is done."
)
STATES = {
    "live": "published, and the current version is what visitors see",
    "changed": "published, with a newer version that isn't approved yet",
    "new": "never published",
    "removal staged": "published, and removed here; the removal waits for approval",
    "removed": "removed and not published",
}

# --- the tools' input schemas, as zod writes them ----------------------------------------

_SCHEMA = "https://json-schema.org/draft/2020-12/schema"
_INT = {"type": "integer", "minimum": -9007199254740991, "maximum": 9007199254740991}
_RECORD = {"type": "object", "propertyNames": {"type": "string"}, "additionalProperties": {}}
_TEXTS = {
    "type": "object",
    "propertyNames": {"type": "string"},
    "additionalProperties": {"type": "string"},
}
_NAME = {"type": "string", "pattern": "^[a-z][a-z0-9-]{0,39}$"}


def _obj(props: dict[str, Any], required: list[str] | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {"type": "object", "$schema": _SCHEMA, "properties": props}
    if required:
        out["required"] = required
    return out


def _tools() -> list[dict[str, Any]]:
    kinds = kind_guide()
    read_only = {"readOnlyHint": True}
    return [
        {
            "name": "site_state",
            "description": "Start here. Returns: `items`, every item with id, kind, version (send it with item_update / item_remove / item_rollback), data, state (see `states`), pending_approval (the approval it's waiting in now, or null) and last_approval (its most recent request and how it ended, or null; an item whose last request was denied or superseded and that the owner didn't ask about again is best left alone); slug is part of the entry's page address, /<stream path>/<slug>/ (the stream's path, or its id), made from its date and title unless set with the entry's slug field; null for other kinds; `kinds`, what each kind is; `fields`, every field of every kind in plain words; `site_defaults`, the values the site item's fields take when unset; `release`, the Porchsite release running; `update`, whether a newer release is published (available; when true also latest, security, changes, migrations, reconnect, how): tell your person in plain words and update only when they say so, following `how`. Then: change items, approval_request the ids you changed, give the owner the review_url.",
            "inputSchema": _obj({}),
            "annotations": read_only,
        },
        {
            "name": "item_create",
            "description": "Create an item; nothing is public until the owner approves. Kinds: "
            + ". ".join(f"{k}: {v}" for k, v in kinds.items())
            + ". data holds that kind's fields (see `fields` in site_state).",
            "inputSchema": _obj(
                {
                    "kind": {"type": "string", "enum": list(kinds)},
                    "data": _RECORD,
                    "idempotency_key": {
                        "description": "Optional. Resending the same key returns the item already created (with replayed: true) instead of a duplicate. Use a new key for a different item.",
                        "type": "string",
                        "maxLength": 100,
                    },
                },
                ["kind", "data"],
            ),
        },
        {
            "name": "item_update",
            "description": "Change some fields of an item; send only the fields that change. version: the item's current version (from site_state or your last write); on version_conflict, re-read and redo.",
            "inputSchema": _obj(
                {
                    "id": {"type": "string"},
                    "version": _INT,
                    "data": _RECORD,
                    "reason": {"type": "string", "maxLength": 300},
                },
                ["id", "version", "data"],
            ),
        },
        {
            "name": "item_remove",
            "description": "Remove an item (recoverable with item_rollback). Takes effect on the site once approved.",
            "inputSchema": _obj(
                {
                    "id": {"type": "string"},
                    "version": _INT,
                    "reason": {"type": "string", "maxLength": 300},
                },
                ["id", "version"],
            ),
        },
        {
            "name": "item_history",
            "description": "Every version of an item, newest first, with who changed it and why; address_change {from, to} marks a version that changed an entry's slug (the old address redirects to the new one).",
            "inputSchema": _obj({"id": {"type": "string"}}, ["id"]),
            "annotations": read_only,
        },
        {
            "name": "item_rollback",
            "description": "Stage an earlier version of an item as a new version. Then ask for approval.",
            "inputSchema": _obj(
                {
                    "id": {"type": "string"},
                    "to_version": _INT,
                    "version": _INT,
                    "reason": {"type": "string", "maxLength": 300},
                },
                ["id", "to_version", "version"],
            ),
        },
        {
            "name": "photo_upload_link",
            "description": "For a photo file: one your person sent you, or one you have yourself (an image with a public https link can go straight into an image field instead). Returns url, which works once, for 30 minutes. Send the file to it yourself: POST multipart/form-data with fields `photo` (the file: JPEG, PNG or WebP, up to 8 MB) and `alt` (what it shows, in a few words), with header Accept: application/json; the answer has `image` (a /media path) and `alt`. If you can't send files, give the url to your person instead: they open it, pick the photo and describe it, and photo_upload_status tells you when it's done. Put `image` in an image field (hero, cover, a card's image, or ![alt](image) in a body) and `alt` in its description field. Nothing shows publicly until the owner approves an item that uses it.",
            "inputSchema": _obj(
                {
                    "purpose": {
                        "default": "",
                        "description": "shown on the upload page, e.g. the cover for your trip post",
                        "type": "string",
                        "maxLength": 200,
                    }
                }
            ),
        },
        {
            "name": "image_add",
            "description": IMAGE_ADD_DESCRIPTION,
            "inputSchema": _obj(
                {
                    "data": {
                        "description": "the picture's bytes, base64 (standard or URL-safe alphabet)",
                        "type": "string",
                    },
                },
                ["data"],
            ),
        },
        {
            "name": "photo_upload_status",
            "description": "How a photo_upload_link is going: status waiting (not sent yet), done (image and alt are ready to use) or expired (ask for a new link).",
            "inputSchema": _obj({"id": {"type": "string"}}, ["id"]),
            "annotations": read_only,
        },
        {
            "name": "theme_list",
            "description": "The site's look. Returns `my_requests` (themes this site asked the community for, each open, answered with the theme that answers it, or closed: tell your person when one is answered), `my_submissions` (looks this site shared: status, the curator's note, and, when the look claimed credit, credit: waiting, credited or not credited), `current` (the theme the site uses now, and the one waiting for approval if it differs), `installed` (themes this site has: built-in ones and ones installed from the catalog), and `catalog` (every theme you can install: name, title, type such as personal or product, description, previews to show your person, version, and author_x: the X handle of the look's maker, when the look is credited). Ask your person what the site is for, show them the catalog themes of that type with their previews, and let them pick.",
            "inputSchema": _obj({}),
            "annotations": read_only,
        },
        {
            "name": "theme_request",
            "description": "When no catalog theme fits what your person's site is for, ask the Porchsite community for one. Sent privately from this site to a queue a curator reads; nothing your person says is published. Describe the site and what it needs, in your own words, without names, addresses or anything personal. Then build with the closest theme meanwhile; theme_list's my_requests shows when it's answered. A site can file 3 a day.",
            "inputSchema": _obj(
                {
                    "type": {
                        "type": "string",
                        "pattern": "^[a-z][a-z0-9-]{1,29}$",
                        "description": "what the site is for, one word or two with a dash: business, club, event, portfolio, family",
                    },
                    "title": {
                        "type": "string",
                        "minLength": 3,
                        "maxLength": 80,
                        "description": "a short name for the look, e.g. Small business with opening hours",
                    },
                    "description": {
                        "type": "string",
                        "minLength": 10,
                        "maxLength": 600,
                        "description": "what the site needs that no theme has, e.g. opening hours, a booking button, a weekly specials list",
                    },
                    "examples": {
                        "default": [],
                        "description": "up to 3 https links to sites your person likes the look of",
                        "maxItems": 3,
                        "type": "array",
                        "items": {"type": "string", "format": "uri"},
                    },
                },
                ["type", "title", "description"],
            ),
        },
        {
            "name": "theme_install",
            "description": "Install (or update) a theme from the Porchsite catalog, by name. Only catalog themes can be installed, and the download is checked against the catalog. Installing changes nothing visitors see: to use it, set the site item's theme field and ask for approval. Then call theme_needs.",
            "inputSchema": _obj({"name": _NAME}, ["name"]),
        },
        {
            "name": "theme_create",
            "description": f"Make a look of your own for this site only (nobody else sees it), when no catalog theme fits and your person wants one now. Read {HOME}/authoring.md first. Send the whole look: manifest (template.json's fields: name, title, type, version, description, slots, art), sample (generic sample content, no real person), pages (home, entry, archive, tag, not_found as Mustache), partials (optional) and css (the stylesheet). No scripts. The site checks it against the template rules and refuses with the list of problems, or stores it. Sending the same name again replaces it (bump version). Then set the site item's theme to its name and ask for approval; your person sees it on the preview first.",
            "inputSchema": _obj(
                {
                    "manifest": _RECORD,
                    "sample": _RECORD,
                    "pages": _TEXTS,
                    "partials": {"default": {}, **_TEXTS},
                    "css": {"type": "string"},
                },
                ["manifest", "sample", "pages", "css"],
            ),
        },
        {
            "name": "theme_submit",
            "description": "Share a look this site made (theme_create) with everyone, ONLY when your person has said yes to sharing it. It goes privately to the Porchsite review queue from this site's server; the checks run again there, a curator reviews it, and the Porchsite owner decides whether it joins the public catalog. theme_list's my_submissions shows where it stands. In note: who the look is for and what it does that no catalog theme does. To credit the maker, pass author_x: their X handle (credit is an X handle and nothing else; never send a name, email or link), only if they want it; the answer's credit.instructions say what they post on X to prove it. A site can share 3 a day.",
            "inputSchema": _obj(
                {
                    "name": _NAME,
                    "note": {"type": "string", "minLength": 10, "maxLength": 600},
                    "author_x": {
                        "description": "the maker's X handle without the @, to credit them in the catalog once verified",
                        "type": "string",
                        "pattern": "^[A-Za-z0-9_]{1,15}$",
                    },
                },
                ["name", "note"],
            ),
        },
        {
            "name": "theme_needs",
            "description": "What a theme wants from this site, checked against the site as it stands now (your unapproved changes included). `images`: each picture slot with field, size (width x height; the shape matters), need (required, recommended, optional), purpose, alt_hint, prompt (a starting point if you make the image) and status (filled, missing, wrong shape, too small). `content`: the words and settings it reads, with what it does with each. `art`: how to make the pictures, as a designer would brief you: what to ask your person (the subject), the style, a prompt_prefix, and the steps, including the checks to run before you use any of it. Follow it. Your person may change the style. Omit name for the site's theme.",
            "inputSchema": _obj({"name": {"type": "string"}}),
            "annotations": read_only,
        },
        {
            "name": "approval_request",
            "description": "Ask the owner to approve items you created, changed or removed (state new, changed, removed or removal staged in site_state). List only the ids for this request; an id with no unapproved change is refused. A newer request for an item replaces it in any older request. Returns id and review_url: give the review_url to the owner (it opens only for them, after they sign in; there is no preview link for you). Nothing goes live until they approve.",
            "inputSchema": _obj(
                {
                    "ids": {
                        "minItems": 1,
                        "maxItems": 50,
                        "type": "array",
                        "items": {"type": "string"},
                    },
                    "note": {"default": "", "type": "string", "maxLength": 1000},
                },
                ["ids"],
            ),
        },
        {
            "name": "approval_status",
            "description": "Look up one approval by approval_id, or omit it for the 10 most recent. Each has review_url, status (pending: something still waits for the owner | decided) and per item: status (pending | published | changes_requested: make the edit in its note, then ask again | denied | superseded: the item changed after you asked, ask again) and note, plus the owner's decision_note.",
            "inputSchema": _obj({"approval_id": {"type": "string"}}),
            "annotations": read_only,
        },
        {
            "name": "site_check",
            "description": CHECK_DESCRIPTION,
            "inputSchema": _obj({}),
            "annotations": read_only,
        },
        {
            "name": "site_stats",
            "description": "Who reads the site: first-party visitor numbers, nothing that identifies a person; the owner, bots and test runs aren't counted. Returns `totals` (visits: one visitor on one day; views; engaged time; the typical visit; bounce_rate; multi_page_rate), `daily`, `pages` (per address: readers, typical and mean engaged time, how far down they read, landings, bounce_rate, exits), `sources` and `referring_domains`, and `tagged` (links you shared with ?src=<where>&p=<post> on the end), and `earlier` (past 90 days only the counts are kept: visits and views by month, newest first; the whole site only). Narrow to the visits that read one item with content_id, or that came from one tagged link with src and post.",
            "inputSchema": _obj(
                {
                    "days": {
                        "default": 7,
                        "description": "the last N days, today included, 1 to 90",
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 90,
                    },
                    "content_id": {
                        "description": "only visits that read this item (an entry's id)",
                        "type": "string",
                    },
                    "src": {
                        "description": "only visits that came from links tagged ?src=<this>",
                        "type": "string",
                    },
                    "post": {
                        "description": "only visits that came from links tagged ?p=<this>",
                        "type": "string",
                    },
                    "include_test": {
                        "default": False,
                        "description": "also count test visits (your own checks, automated browsers)",
                        "type": "boolean",
                    },
                }
            ),
            "annotations": read_only,
        },
    ]


TOOLS = _tools()
_BY_NAME = {t["name"]: t for t in TOOLS}


# --- checking arguments the way zod does ---------------------------------------------------


def _received(v: Any) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "boolean"
    if isinstance(v, int | float):
        return "number"
    if isinstance(v, str):
        return "string"
    if isinstance(v, list):
        return "array"
    return "object"


def _is_url(v: str) -> bool:
    try:
        p = urlsplit(v)
    except ValueError:
        return False
    return bool(re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*\Z", p.scheme or "")) and bool(
        p.netloc or p.path
    )


def _check(schema: dict[str, Any], v: Any, path: list[str], issues: list[str]) -> Any:
    def bad(msg: str) -> None:
        issues.append(f"{'.'.join(path)}: {msg}" if path else msg)

    if "enum" in schema:
        if v not in schema["enum"]:
            bad("Invalid option: expected one of " + "|".join(f'"{x}"' for x in schema["enum"]))
        return v
    t = schema.get("type")
    if t == "string":
        if not isinstance(v, str):
            bad(f"Invalid input: expected string, received {_received(v)}")
            return v
        n = len(v.encode("utf-16-le")) // 2
        if "minLength" in schema and n < schema["minLength"]:
            bad(f"Too small: expected string to have >={schema['minLength']} characters")
        if "maxLength" in schema and n > schema["maxLength"]:
            bad(f"Too big: expected string to have <={schema['maxLength']} characters")
        if "pattern" in schema and not re.search(schema["pattern"].replace("$", r"\Z"), v):
            bad(f"Invalid string: must match pattern /{schema['pattern']}/")
        if schema.get("format") == "uri" and not _is_url(v):
            bad("Invalid URL")
        return v
    if t == "integer":
        if isinstance(v, bool) or not isinstance(v, int | float):
            bad(f"Invalid input: expected number, received {_received(v)}")
            return v
        if isinstance(v, float) and not v.is_integer():
            bad("Invalid input: expected int, received number")
            return v
        if "minimum" in schema and v < schema["minimum"] and schema["minimum"] > -9007199254740991:
            bad(f"Too small: expected number to be >={schema['minimum']}")
        if "maximum" in schema and v > schema["maximum"] and schema["maximum"] < 9007199254740991:
            bad(f"Too big: expected number to be <={schema['maximum']}")
        return int(v)
    if t == "boolean":
        if not isinstance(v, bool):
            bad(f"Invalid input: expected boolean, received {_received(v)}")
        return v
    if t == "array":
        if not isinstance(v, list):
            bad(f"Invalid input: expected array, received {_received(v)}")
            return v
        if "minItems" in schema and len(v) < schema["minItems"]:
            bad(f"Too small: expected array to have >={schema['minItems']} items")
        if "maxItems" in schema and len(v) > schema["maxItems"]:
            bad(f"Too big: expected array to have <={schema['maxItems']} items")
        return [_check(schema["items"], x, [*path, str(i)], issues) for i, x in enumerate(v)]
    if t == "object":
        if not isinstance(v, dict):
            bad(f"Invalid input: expected record, received {_received(v)}")
            return v
        each = schema.get("additionalProperties") or {}
        return {k: _check(each, x, [*path, k], issues) if each else x for k, x in v.items()}
    return v


def parse_args(name: str, args: dict[str, Any] | None) -> tuple[dict[str, Any], str]:
    """(arguments with defaults filled in, "") or ({}, the refusal text)."""
    schema = _BY_NAME[name]["inputSchema"]
    args = args or {}
    required = set(schema.get("required") or [])
    out: dict[str, Any] = {}
    issues: list[str] = []
    for key, prop in schema["properties"].items():
        if key not in args or args[key] is None and key not in required and "default" not in prop:
            if "default" in prop:
                out[key] = prop["default"]
            elif key in required:
                want = "string" if "enum" in prop else prop.get("type", "value")
                want = {"integer": "number", "object": "record"}.get(want, want)
                issues.append(f"{key}: Invalid input: expected {want}, received undefined")
            continue
        out[key] = _check(prop, args[key], [key], issues)
    if issues:
        return {}, f"Input validation error: Invalid arguments for tool {name}: {', '.join(issues)}"
    return out, ""


# --- results -------------------------------------------------------------------------------


def _ok(v: Any) -> types.CallToolResult:
    return types.CallToolResult(content=[types.TextContent(text=dumps(v))], structured_content=v)


def _refusal(text: str) -> types.CallToolResult:
    return types.CallToolResult(content=[types.TextContent(text=text)], is_error=True)


async def _run(fn: Callable[[], Awaitable[Any]]) -> types.CallToolResult:
    try:
        v = await fn()
    except ApiError as e:
        return _refusal(dumps(e.to_json()))
    return _ok({"items": v} if isinstance(v, list) else v)


async def describe(db: Db, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """One item shape for every tool: data plus where it stands."""
    live = {r["item_id"]: r["version"] for r in await db.fetch("SELECT item_id, version FROM live")}
    waiting: dict[str, str] = {}
    last_seen: dict[str, dict[str, Any]] = {}
    # Newest first, so the first time an item appears is its latest request.
    for a in await approvals.list(db):
        for i in a["items"]:
            if i["status"] == "pending" and i["id"] not in waiting:
                waiting[i["id"]] = a["id"]
            if i["id"] not in last_seen:
                last_seen[i["id"]] = {"id": a["id"], "status": i["status"], "note": i["note"]}
    out = []
    for i in items:
        lv = live.get(i["id"])
        if i["deleted"]:
            state = "removal staged" if lv is not None else "removed"
        else:
            state = "new" if lv is None else "live" if lv == i["version"] else "changed"
        out.append(
            {
                **i,
                "state": state,
                "live_version": lv,
                "pending_approval": waiting.get(i["id"]),
                "last_approval": last_seen.get(i["id"]),
            }
        )
    return out


# --- the server ------------------------------------------------------------------------------


def create_server(pool: Callable[[], Db], release: Callable[[], str]) -> Server:
    """The MCP server. `pool` gives the database; `release` the running release."""

    async def list_tools(ctx: Any, params: Any) -> types.ListToolsResult:
        return types.ListToolsResult(tools=[types.Tool.model_validate(t) for t in TOOLS])

    async def call_tool(ctx: Any, params: types.CallToolRequestParams) -> types.CallToolResult:
        name = params.name
        if name not in _BY_NAME:
            raise MCPError(-32602, f"Tool {name} not found")
        args, refused = parse_args(name, params.arguments)
        if refused:
            return _refusal(refused)
        request = getattr(ctx, "request", None)
        props: dict[str, Any] = (request.scope.get("porchsite.props") if request else None) or {}
        try:
            return await _call(pool(), name, args, props, release())
        except Exception as e:
            log.exception("tool %s failed", name)
            return _refusal(str(e))

    return _Server(
        "porchsite",
        version="0.0.1",
        instructions=INSTRUCTIONS,
        on_list_tools=list_tools,
        on_call_tool=call_tool,
    )


class _Server(Server):
    """Says its tool list can change, as the Cloudflare edition's server does."""

    def create_initialization_options(
        self, notification_options: Any = None, *args: Any, **kwargs: Any
    ) -> Any:
        return super().create_initialization_options(
            notification_options or NotificationOptions(tools_changed=True), *args, **kwargs
        )


async def _call(
    db: Db, name: str, a: dict[str, Any], props: dict[str, Any], release: str
) -> types.CallToolResult:
    actor = f"assistant:{props.get('client') or 'unknown'}"
    origin = props.get("origin") or ""

    if name == "site_state":

        async def site_state() -> Any:
            return {
                "items": await describe(db, await content.all_items(db)),
                "states": STATES,
                "kinds": kind_guide(),
                "fields": field_guide(),
                "site_defaults": content.validate("site", {}),
                "release": release,
                "update": await updates.check(db, release),
            }

        return await _run(site_state)

    if name == "item_create":

        async def item_create() -> Any:
            item = await content.create_item(
                db, actor, a["kind"], a["data"], a.get("idempotency_key")
            )
            [shown] = await describe(db, [await content.get_item(db, item["id"])])
            return {**shown, **({"replayed": True} if item.get("replayed") else {}), "next": NEXT}

        return await _run(item_create)

    if name == "item_update":

        async def item_update() -> Any:
            item = await content.update_item(
                db, actor, a["id"], a["version"], a["data"], a.get("reason") or ""
            )
            return {**(await describe(db, [item]))[0], "next": NEXT}

        return await _run(item_update)

    if name == "item_remove":

        async def item_remove() -> Any:
            item = await content.remove_item(
                db, actor, a["id"], a["version"], a.get("reason") or ""
            )
            return {**(await describe(db, [item]))[0], "next": NEXT}

        return await _run(item_remove)

    if name == "item_history":
        return await _run(lambda: _versions(db, a["id"]))

    if name == "item_rollback":

        async def item_rollback() -> Any:
            item = await content.rollback(
                db, actor, a["id"], a["to_version"], a["version"], a.get("reason") or ""
            )
            return {**(await describe(db, [item]))[0], "next": NEXT}

        return await _run(item_rollback)

    if name == "image_add":

        async def image_add() -> Any:
            raw = re.sub(r"^data:[^,]*,", "", a["data"])
            raw = re.sub(r"\s", "", raw).replace("-", "+").replace("_", "/")
            try:
                data = base64.b64decode(raw + "=" * (-len(raw) % 4), validate=True)
            except (ValueError, binascii.Error):
                raise ApiError(422, "invalid", "data isn't base64.") from None
            if len(data) > media.MAX_BYTES:
                raise ApiError(413, "too_large", "A picture can be at most 8 MB.")
            type_ = media.sniff(data)
            if not type_:
                raise ApiError(422, "not_an_image", "That isn't a JPEG, PNG or WebP picture.")
            image = await media.store(db, data, type_, actor)
            width, height = media.size(data)
            return {
                "image": image,
                "width": width,
                "height": height,
                "next": "Put image in an image field with a description, then ask for approval as usual.",
            }

        return await _run(image_add)

    if name == "photo_upload_link":

        async def photo_upload_link() -> Any:
            u = await uploads.create(db, actor, a["purpose"])
            path = u.pop("path")
            return {
                **u,
                "url": f"{origin}{path}",
                "next": "Send the url to your person, then check photo_upload_status with this id.",
            }

        return await _run(photo_upload_link)

    if name == "photo_upload_status":
        return await _run(lambda: uploads.get(db, a["id"]))

    if name == "theme_list":

        async def theme_list() -> Any:
            live = str((await content.site_data(db, True))["theme"])
            staged = str((await content.site_data(db, False))["theme"])
            catalog: list[dict[str, Any]] = []
            catalog_error = ""
            try:
                catalog = themes.listing(await themes.catalog())
            except ApiError as e:
                catalog_error = e.message
            return {
                "current": {"live": live, "waiting": staged if staged != live else None},
                "installed": await themes.installed(db),
                "catalog": catalog,
                **({"catalog_error": catalog_error} if catalog_error else {}),
                "my_requests": await requests.mine(db),
                "my_submissions": await requests.my_submissions(db),
            }

        return await _run(theme_list)

    if name == "theme_request":

        async def theme_request() -> Any:
            return {
                **(await requests.file(db, origin, actor, a)),
                "next": "Tell your person you've asked; build with the closest theme meanwhile.",
            }

        return await _run(theme_request)

    if name == "theme_install":

        async def theme_install() -> Any:
            return {
                **(await themes.install(db, a["name"], actor)),
                "next": "Set the site item's theme to this name (item_update), call theme_needs to see what it wants, fill that in, then approval_request.",
            }

        return await _run(theme_install)

    if name == "theme_create":

        async def theme_create() -> Any:
            return {
                **(await themes.create(db, a, actor)),
                "source": "private",
                "next": "Set the site item's theme to this name (item_update), call theme_needs, fill what it lists, then approval_request; your person checks the preview before approving.",
            }

        return await _run(theme_create)

    if name == "theme_submit":

        async def theme_submit() -> Any:
            r = await requests.submit(
                db, origin, actor, a["name"], a["note"], author_x=a.get("author_x")
            )
            return {
                **r,
                "next": "Tell your person it's been sent for review, and give them credit.instructions word for word: the look is credited only after that post. You'll see its status in theme_list."
                if r.get("credit")
                else "Tell your person it's been sent for review; you'll see its status in theme_list.",
            }

        return await _run(theme_submit)

    if name == "theme_needs":

        async def theme_needs() -> Any:
            want = (
                a["name"]
                if a.get("name") is not None
                else str((await content.site_data(db, False))["theme"])
            )
            t = await themes.load(db, want)
            if not t:
                raise ApiError(
                    404,
                    "no_such_theme",
                    f"This site doesn't have a theme called {want}. theme_list shows what it has; theme_install adds one from the catalog.",
                )
            return await themes.needs(db, t)

        return await _run(theme_needs)

    if name == "approval_request":

        async def approval_request() -> Any:
            r = await approvals.request(db, actor, a["ids"], a["note"])
            return {
                **r,
                "review_url": f"{origin}/review/{r['id']}",
                "next": "Send the review_url to the owner; they sign in with their passkey to decide. Check approval_status before changing these items again.",
            }

        return await _run(approval_request)

    if name == "site_check":

        async def site_check() -> Any:
            changes = [{"id": i["id"], "version": i["version"]} for i in await content.staged(db)]
            v = await site.proposed_view(db, changes)
            names = {r["name"] for r in await db.fetch("SELECT name FROM media")}
            return check.check_site(v, names, await themes.load(db, str(v.site["theme"])), origin)

        return await _run(site_check)

    if name == "site_stats":
        return await _run(
            lambda: analytics.stats(
                db,
                days=a["days"],
                content_id=a.get("content_id"),
                src=a.get("src"),
                post=a.get("post"),
                include_test=a["include_test"],
            )
        )

    # approval_status
    async def approval_status() -> Any:
        def with_url(x: dict[str, Any]) -> dict[str, Any]:
            return {**x, "review_url": f"{origin}/review/{x['id']}"}

        if a.get("approval_id"):
            return with_url(await approvals.get(db, a["approval_id"]))
        return {"approvals": [with_url(x) for x in (await approvals.list(db))[:10]]}

    return await _run(approval_status)


async def _versions(db: Db, id: str) -> dict[str, Any]:
    return {"versions": await content.history(db, id)}
