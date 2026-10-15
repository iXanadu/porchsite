"""Bounded image_add preflight followed by one atomic storage transaction."""

import base64
import binascii
import re

from . import media
from .db import Db, transaction
from .errors import ApiError
from .photo_advice import photo_next
from .image_privacy import strip_location

MAX_FILES = 8
MAX_TOTAL = 8 * 1024 * 1024
NEXT = "Put image in an image field with a description, then ask for approval as usual."


def _preflight(value: str) -> tuple[str, int]:
    raw = re.sub(r"^data:[^,]*,", "", value)
    raw = re.sub(r"\s", "", raw).replace("-", "+").replace("_", "/")
    padding = 2 if raw.endswith("==") else 1 if raw.endswith("=") else 0
    count = len(raw) - padding
    if re.search(r"[^A-Za-z0-9+/]", raw[:count]) or count % 4 == 1 or (padding and len(raw) % 4):
        raise ApiError(422, "invalid", "data isn't base64.")
    return raw, count * 3 // 4


async def image_add(db: Db, actor: str, data: str | None = None, images: list[str] | None = None):
    if (data is not None) == (images is not None):
        raise ApiError(422, "invalid", "Give exactly one of data or images.")
    values = images if images is not None else [data]
    if not values or len(values) > MAX_FILES:
        raise ApiError(422, "invalid", "Send 1 to 8 pictures.")
    files = [_preflight(v) for v in values]
    if any(n > media.MAX_BYTES for _, n in files):
        raise ApiError(413, "too_large", "A picture can be at most 8 MB.")
    if sum(n for _, n in files) > MAX_TOTAL:
        raise ApiError(413, "too_large", "Pictures can total at most 8 MB.")
    checked = []
    for raw, _ in files:
        try:
            decoded = base64.b64decode(raw + "=" * (-len(raw) % 4), validate=True)
        except (ValueError, binascii.Error):
            raise ApiError(422, "invalid", "data isn't base64.") from None
        type_ = media.sniff(decoded)
        if not type_:
            raise ApiError(422, "not_an_image", "That isn't a JPEG, PNG or WebP picture.")
        decoded = strip_location(decoded, type_)
        checked.append((decoded, type_, media.size(decoded)))
    out = []
    async with transaction(db) as c:
        for decoded, type_, (width, height) in checked:
            image = await media.store(c, decoded, type_, actor)
            out.append({"image": image, "width": width, "height": height})
    next_ = photo_next(NEXT, [len(decoded) for decoded, _, _ in checked], images is not None)
    return {"images": out, "next": next_} if images is not None else {**out[0], "next": next_}
