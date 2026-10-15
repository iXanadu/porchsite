"""Content kinds (port of cloudflare/src/models.ts, SPEC §3). Same field
names, defaults, limits and checks as the zod schemas; unknown fields are
refused, so typos fail loudly. Lengths count UTF-16 code units, as zod does.
"""

import re
from collections.abc import Callable
from typing import Annotated, Any, Literal

from pydantic import (
    AfterValidator,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    Strict,
    create_model,
    model_serializer,
)

from .jsutil import trim, u16len, valid_zone
from .strings import STRINGS

# --- field kinds ---------------------------------------------------------------------


# Problems are worded as the Cloudflare edition's zod words them.


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


def _str(v: Any) -> str:
    if not isinstance(v, str):
        raise ValueError(f"Invalid input: expected string, received {_received(v)}")
    return v


def _check(*steps: Callable[[str], str]) -> Callable[[Any], str]:
    def run(v: Any) -> str:
        v = _str(v)
        for step in steps:
            v = step(v)
        return v

    return run


def _trim(v: str) -> str:
    return trim(v)


def _min(n: int) -> Callable[[str], str]:
    def f(v: str) -> str:
        if u16len(v) < n:
            raise ValueError(f"Too small: expected string to have >={n} characters")
        return v

    return f


def _max(n: int) -> Callable[[str], str]:
    def f(v: str) -> str:
        if u16len(v) > n:
            raise ValueError(f"Too big: expected string to have <={n} characters")
        return v

    return f


def _regex(pattern: str, message: str = "invalid format") -> Callable[[str], str]:
    rx = re.compile(pattern)

    def f(v: str) -> str:
        if not rx.search(v):
            raise ValueError(message)
        return v

    return f


def _refine(ok: Callable[[str], bool], message: str) -> Callable[[str], str]:
    def f(v: str) -> str:
        if not ok(v):
            raise ValueError(message)
        return v

    return f


def _or_empty(*steps: Callable[[str], str]) -> Callable[[Any], str]:
    """z.union([z.literal(""), <steps>])"""
    rest = _check(*steps)

    def run(v: Any) -> str:
        return "" if v == "" else rest(v)

    return run


def text(*steps: Callable[[str], str]) -> Any:
    return Annotated[str, BeforeValidator(_check(*steps))]


def line(n: int) -> Any:
    return text(_trim, _min(1), _max(n))


def opt_line(n: int) -> Any:
    return text(_trim, _max(n))


_NS = "[^\t\n\v\f\r    -     　﻿]"
_NS_AT = "[^\t\n\v\f\r    -     　﻿@]"
URL_MESSAGE = (
    "must be a full https:// link (e.g. https://example.com/page), a path on this site starting with / (e.g. /about), "
    "#name for a place on the same page, mailto:someone@example.com or tel:+12025550100"
)
_URL_OK = [
    re.compile(rf"^https://{_NS}+\Z"),
    re.compile(rf"^/{_NS}*\Z"),
    re.compile(r"^#[a-z][a-z0-9-]{0,40}\Z"),
    re.compile(rf"^mailto:{_NS_AT}+@{_NS_AT}+\Z"),
    re.compile(r"^tel:\+?[0-9\t\n\v\f\r    -     　﻿().-]{4,30}\Z"),
]
_URL_STEPS = (_trim, _max(500), _refine(lambda u: any(r.search(u) for r in _URL_OK), URL_MESSAGE))
Url = text(*_URL_STEPS)
OptLink = Annotated[str, BeforeValidator(_or_empty(*_URL_STEPS))]
_IMAGE_OK = [re.compile(rf"^https://{_NS}+\Z"), re.compile(rf"^/media/{_NS}+\Z")]
Image = text(
    _trim,
    _max(500),
    _refine(
        lambda u: u == "" or any(r.search(u) for r in _IMAGE_OK),
        "must be a full https:// link to the image, or a /media/... path from this site",
    ),
)
Alt = opt_line(200)
Day = text(
    _regex(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}\Z", "must be a date written YYYY-MM-DD, e.g. 2026-10-08")
)
OptDay = Annotated[
    str,
    BeforeValidator(
        _or_empty(
            _regex(
                r"^[0-9]{4}-[0-9]{2}-[0-9]{2}\Z",
                "must be a date written YYYY-MM-DD, e.g. 2026-10-08",
            )
        )
    ),
]
_HHMM = _regex(
    r"^([01][0-9]|2[0-3]):[0-5][0-9]\Z", "a 24-hour time written HH:MM, e.g. 09:00 or 17:30"
)
Hhmm = text(_HHMM)
OptHhmm = Annotated[str, BeforeValidator(_or_empty(_HHMM))]
_EMAIL = _regex(
    r"^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}\Z",
    "invalid email address",
)
OptEmail = Annotated[str, BeforeValidator(_or_empty(_trim, _EMAIL, _max(120)))]
Bool = Annotated[bool, Strict()]
Weekday = Literal["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


def _int(lo: int, hi: int) -> Callable[[Any], int]:
    def f(v: Any) -> int:
        if isinstance(v, bool) or not isinstance(v, int | float):
            raise ValueError(f"Invalid input: expected number, received {_received(v)}")
        if v != v or v in (float("inf"), float("-inf")) or int(v) != v:
            raise ValueError("Invalid input: expected int, received number")
        if v < lo:
            raise ValueError(f"Too small: expected number to be >={lo}")
        if v > hi:
            raise ValueError(f"Too big: expected number to be <={hi}")
        return int(v)

    return f


def _list(
    lo: int | None = None,
    hi: int | None = None,
    unique: str | None = None,
    key: Callable[[Any], Any] = lambda x: x,
) -> Any:
    def f(v: list) -> list:
        if lo is not None and len(v) < lo:
            raise ValueError(f"Too small: expected array to have >={lo} items")
        if hi is not None and len(v) > hi:
            raise ValueError(f"Too big: expected array to have <={hi} items")
        if unique and len({key(x) for x in v}) != len(v):
            raise ValueError(unique)
        return v

    return f


def _strict_list(v: Any) -> Any:
    if not isinstance(v, list):
        raise ValueError(f"Invalid input: expected array, received {_received(v)}")
    return v


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    def data(self) -> dict[str, Any]:
        return self.model_dump(by_alias=True)


def list_of(
    item: Any,
    lo: int | None = None,
    hi: int | None = None,
    unique: str | None = None,
    key: Callable[[Any], Any] = lambda x: x,
) -> Any:
    return Annotated[
        list[item], BeforeValidator(_strict_list), AfterValidator(_list(lo, hi, unique, key))
    ]


# --- the kinds -----------------------------------------------------------------------


class Address(_Model):
    line1: opt_line(120) = ""
    line2: opt_line(120) = ""
    city: opt_line(60) = ""
    region: opt_line(60) = ""
    postcode: opt_line(20) = ""
    country: opt_line(60) = ""


class Social(_Model):
    kind: line(30)
    url: Url


class Contact(_Model):
    phone: opt_line(30) = ""
    email: OptEmail = ""
    address: Address = Field(default_factory=Address)
    map_link: OptLink = ""
    social: list_of(Social, hi=8) = Field(default_factory=list)


class WeeklyRow(_Model):
    day: Weekday
    open: OptHhmm = ""
    close: OptHhmm = ""
    closed: Bool = False


class HoursException(_Model):
    from_: Day = Field(alias="from")
    to: OptDay = ""
    label: opt_line(60) = ""
    open: OptHhmm = ""
    close: OptHhmm = ""
    closed: Bool = True


class Hours(_Model):
    weekly: list_of(WeeklyRow, hi=14) = Field(default_factory=list)
    exceptions: list_of(HoursException, hi=40) = Field(default_factory=list)
    note: opt_line(200) = ""


SITE_ID = "site"
RESERVED = [
    "cards",
    "notes",
    "about",
    "entries",
    "e",
    "media",
    "review",
    "setup",
    "upload",
    "mcp",
    "authorize",
    "oauth",
    "login",
    "logout",
    "static",
    "robots-txt",
    "collect",
]
_RESERVED_MSG = f"can't be one of: {', '.join(RESERVED)}"


class Stream(_Model):
    id: text(
        _regex(
            r"^[a-z][a-z0-9-]{0,29}\Z",
            "lowercase letters, digits or dashes, starting with a letter, e.g. writing",
        ),
        _refine(lambda v: v not in RESERVED, _RESERVED_MSG),
    )
    title: line(60)
    byline: opt_line(160) = ""
    layout: Literal["list", "cards", "feature"] = "list"
    link_label: opt_line(40) = ""
    intro: opt_line(600) = ""
    author: opt_line(60) = ""
    nav_label: opt_line(30) = ""
    path: text(
        _regex(r"^([a-z][a-z0-9-]{0,29})?\Z", "lowercase letters, digits or dashes, e.g. reports"),
        _refine(lambda v: v not in RESERVED, _RESERVED_MSG),
    ) = ""
    anchor: opt_line(30) = ""
    description: opt_line(300) = ""
    feed_subtitle: opt_line(160) = ""
    see_also_label: opt_line(80) = ""
    all_label: opt_line(60) = ""
    dated_addresses: Bool = True


class Notice(_Model):
    text: opt_line(200) = ""
    until: OptDay = ""


class Button(_Model):
    label: line(60)
    url: Url
    note: opt_line(120) = ""


class Link(_Model):
    label: line(40)
    url: Url


class CardGroup(_Model):
    name: line(60)
    style: Literal["", "list", "faq", "steps", "reviews"] = ""


def _default_streams() -> list[Stream]:
    return [Stream(id="journal", title="Updates")]


class _Strings(_Model):
    """The look's own words, overridden by name (strings.STRINGS); a name
    left out keeps its default."""

    @model_serializer(mode="wrap")
    def _set_only(self, handler: Any) -> dict[str, Any]:
        return {k: v for k, v in handler(self).items() if v is not None}


Strings = create_model(
    "Strings",
    __base__=_Strings,
    **{k: (opt_line(120), None) for k in STRINGS},  # type: ignore[call-overload]
)


class SiteData(_Model):
    """Every word on the site that isn't an entry, card or note."""

    title: line(80) = "My site"
    tagline: opt_line(160) = ""
    description: opt_line(300) = ""
    intro: text(_trim, _max(1200)) = ""
    about: text(_trim, _max(8000)) = ""
    owner_name: opt_line(80) = ""
    links: list_of(Link, hi=8) = Field(default_factory=list)
    hero: Image = ""
    hero_alt: Alt = ""
    logo: Image = ""
    logo_alt: Alt = ""
    follow_image: Image = ""
    follow_image_alt: Alt = ""
    share_image: Image = ""
    share_image_alt: Alt = ""
    palette: text(_regex(r"^([a-z][a-z0-9-]{0,29})?\Z")) = ""
    contact: Contact = Field(default_factory=Contact)
    hours: Hours = Field(default_factory=Hours)
    notice: Notice = Field(default_factory=Notice)
    buttons: list_of(Button, hi=24) = Field(default_factory=list)
    hero_caption: opt_line(200) = ""
    theme: text(_regex(r"^[a-z][a-z0-9-]{0,39}\Z")) = "built-in"
    handle: text(
        _regex(r"^([A-Za-z0-9_]{1,15})?\Z", "an X handle without the @, e.g. your_handle")
    ) = ""
    follow_label: opt_line(40) = ""
    logo_text: opt_line(40) = ""
    footer_line: opt_line(120) = ""
    contact_line: opt_line(80) = ""
    cta_label: opt_line(60) = ""
    cta_link: OptLink = ""
    timezone: text(
        _trim, _max(60), _refine(valid_zone, "an IANA time zone, e.g. America/New_York")
    ) = "UTC"
    cards_aside: opt_line(30) = ""
    cta2_label: opt_line(60) = ""
    cta2_link: OptLink = ""
    streams: list_of(
        Stream, lo=1, hi=8, unique="each stream id at most once", key=lambda x: x.id
    ) = Field(default_factory=_default_streams)
    cards_title: line(60) = "Projects"
    cards_nav: opt_line(30) = ""
    cards_anchor: opt_line(30) = ""
    notes_title: line(60) = "Lately"
    about_title: line(60) = "About"
    sections: list_of(
        text(_regex(r"^[a-z][a-z0-9-]{0,29}\Z", "a stream id, or cards, notes, about")),
        hi=12,
        unique="each section at most once",
    ) = Field(default_factory=lambda: ["entries", "cards", "notes", "about"])
    card_groups: list_of(
        CardGroup, hi=24, unique="each group name at most once", key=lambda x: x.name
    ) = Field(default_factory=list)
    strings: Strings = Field(default_factory=lambda: Strings())


_STAMP = r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]\Z"


class Stat(_Model):
    value: line(20)
    label: line(40)


class Place(_Model):
    name: opt_line(120) = ""
    address: opt_line(200) = ""
    map_link: OptLink = ""


class Rsvp(_Model):
    label: opt_line(40) = ""
    link: OptLink = ""
    deadline: OptDay = ""


class ScheduleRow(_Model):
    time: Hhmm
    title: line(120)
    note: opt_line(200) = ""


class Event(_Model):
    start: text(
        _regex(_STAMP, "a local date and time written YYYY-MM-DDTHH:MM, e.g. 2026-06-13T18:00")
    )
    end: Annotated[str, BeforeValidator(_or_empty(_regex(_STAMP)))] = ""
    place: Place = Field(default_factory=Place)
    rsvp: Rsvp = Field(default_factory=Rsvp)
    schedule: list_of(ScheduleRow, hi=30) = Field(default_factory=list)
    status: Literal["on", "changed", "cancelled"] = "on"


SLUG = r"^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?\Z"


class EntryData(_Model):
    stream: opt_line(30) = ""
    title: line(160)
    date: Day
    summary: text(_trim, _max(600)) = ""
    body: text(_max(60000)) = ""
    cover: Image = ""
    cover_alt: Alt = ""
    external_url: OptLink = ""
    stats: list_of(Stat, hi=6) = Field(default_factory=list)
    tags: list_of(
        text(_regex(r"^[a-z0-9-]{1,30}\Z", "lowercase words or-dashes, e.g. garden")), hi=10
    ) = Field(default_factory=list)
    event: Event | None = None
    status: Literal["draft", "ready"] = "ready"
    # Optional, as in zod: absent from the data unless sent (SPEC §3).
    slug: text(
        _regex(
            SLUG,
            "lowercase letters, digits and dashes (not first or last), at most 80, e.g. how-it-works",
        )
    ) = None

    def data(self) -> dict[str, Any]:
        out = super().data()
        if out.get("slug") is None:
            out.pop("slug", None)
        return out


class CardData(_Model):
    name: line(80)
    description: text(_trim, _min(1), _max(600))
    link: OptLink = ""
    link_label: opt_line(40) = ""
    image: Image = ""
    image_alt: Alt = ""
    badge_tone: Literal["live", "building"] = "building"
    badge: opt_line(30) = ""
    group: opt_line(30) = ""
    subtitle: opt_line(120) = ""
    period: opt_line(40) = ""
    price: opt_line(30) = ""
    tags: list_of(opt_line(20), hi=8) = Field(default_factory=list)
    sort: Annotated[int, BeforeValidator(_int(0, 10000))] = 100
    visibility: Literal["public", "mention", "private"] = "public"


class NoteData(_Model):
    text: line(240)
    date: Day
    link: OptLink = ""


# The tool/view extension is separate from the rollback-compatible SiteData.
# Keep its existing field order, shared with the Cloudflare field guide.
SiteInput = create_model(
    "SiteInput",
    __base__=_Model,
    embed_sources=(list_of(text(_max(2000)), hi=20), Field(default_factory=list)),
    **{name: (field.annotation, field) for name, field in SiteData.model_fields.items()},
)


MODELS: dict[str, type[_Model]] = {
    "site": SiteInput,
    "entry": EntryData,
    "card": CardData,
    "note": NoteData,
}
KINDS = list(MODELS)
PREFIX = {"site": "site", "entry": "ent", "card": "crd", "note": "nte"}


def parse(kind: str, data: Any) -> dict[str, Any]:
    """MODELS[kind].parse(data): the checked data, defaults filled in, as plain values."""
    return MODELS[kind].model_validate(data).data()
