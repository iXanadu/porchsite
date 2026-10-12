"""Share cards (SPEC §5): the picture a link to an entry shows when shared,
its photo with its title over it in large type. The owner's browser draws
them (CARD_JS, on /review), so the site itself does no image work: it lists
the published entries whose card is missing or older than the entry, and
keeps the JPEGs the browser sends back. Port of cloudflare/src/sharecards.ts
(the same script, byte for byte).
"""

from datetime import UTC, datetime
from typing import Any

from server.spec.theme import streams

from . import media, site
from .db import Db
from .errors import ApiError

CARD_W, CARD_H = 1200, 630
MAX = 800 * 1024


async def missing(db: Db, host: str) -> list[dict[str, Any]]:
    """Published entries whose card is missing or was drawn for an older version."""
    v = await site.live_view(db)
    versions = {
        r["item_id"]: r["version"]
        for r in await db.fetch("SELECT item_id, version FROM live WHERE kind = 'entry'")
    }
    have = {
        r["item_id"]: r["version"]
        for r in await db.fetch("SELECT item_id, version FROM share_cards")
    }
    st = streams(v.site)
    out = []
    for e in v.entries:
        version = versions.get(e["id"])
        if e.get("external_url") or version is None or have.get(e["id"]) == version:
            continue
        stream = next((x for x in st if x["id"] == e["stream"]), None)
        photo = str(e.get("cover") or v.site.get("share_image") or v.site.get("hero") or "")
        out.append(
            {
                "id": e["id"],
                "version": version,
                "title": str(e.get("title") or ""),
                "label": f"{stream['nav_label']} · {host}" if stream else host,
                "photo": photo if media.LOCAL.search(photo) else "",
            }
        )
    return out


async def save(db: Db, id: str, version: int, data: bytes) -> str:
    """Keep the card the owner's browser drew for this entry at this version."""
    live = await db.fetchrow("SELECT version FROM live WHERE item_id = $1 AND kind = 'entry'", id)
    if not live or live["version"] != version:
        raise ApiError(409, "not_current", "That entry isn't published at that version.")
    if len(data) > MAX or media.sniff(data) != "image/jpeg":
        raise ApiError(422, "invalid", "A share card is a JPEG of at most 800 KB.")
    if media.size(data) != (CARD_W, CARD_H):
        raise ApiError(422, "invalid", f"A share card is {CARD_W} x {CARD_H} pixels.")
    path = await media.store(db, data, "image/jpeg", f"share card {id}")
    await db.execute(
        "INSERT INTO share_cards (item_id, version, name, created_at) VALUES ($1, $2, $3, $4)"
        " ON CONFLICT (item_id) DO UPDATE SET version = excluded.version, name = excluded.name,"
        " created_at = excluded.created_at",
        id,
        version,
        path[len("/media/") :],
        datetime.now(UTC).isoformat(),
    )
    return path


# The owner's pages run this: draw each missing card on a canvas and send it
# back. An element #share-cards carries the CSRF token.
CARD_JS = r"""(async function () {
  var box = document.getElementById("share-cards");
  if (!box || !window.fetch || !document.createElement("canvas").getContext) return;
  var W = 1200, H = 630, PAD = 64;
  var want;
  try { want = await (await fetch("/review/cards.json")).json(); } catch (e) { return; }
  function load(src) {
    return new Promise(function (ok) {
      if (!src) return ok(null);
      var img = new Image();
      img.onload = function () { ok(img); };
      img.onerror = function () { ok(null); };
      img.src = src;
    });
  }
  function wrap(ctx, text, width) {
    var lines = [], line = "";
    text.split(/\s+/).forEach(function (word) {
      var trial = line ? line + " " + word : word;
      if (ctx.measureText(trial).width <= width || !line) line = trial;
      else { lines.push(line); line = word; }
    });
    if (line) lines.push(line);
    return lines;
  }
  for (var i = 0; i < (want.cards || []).length; i++) {
    var c = want.cards[i];
    try {
      var canvas = document.createElement("canvas");
      canvas.width = W; canvas.height = H;
      var ctx = canvas.getContext("2d");
      ctx.fillStyle = "#201e1d"; ctx.fillRect(0, 0, W, H);
      var img = await load(c.photo);
      if (img) {
        var s = Math.max(W / img.naturalWidth, H / img.naturalHeight);
        var w = img.naturalWidth * s, h = img.naturalHeight * s;
        ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
      }
      var g = ctx.createLinearGradient(0, H * 0.25, 0, H * 0.8);
      g.addColorStop(0, "rgba(12,10,9,0)"); g.addColorStop(1, "rgba(12,10,9,0.91)");
      ctx.fillStyle = g; ctx.fillRect(0, H * 0.25, W, H * 0.75);
      var size = 84, lines;
      for (; size >= 40; size -= 4) {
        ctx.font = "700 " + size + "px Georgia, 'Times New Roman', serif";
        lines = wrap(ctx, c.title || c.label, W - 2 * PAD);
        if (lines.length <= 3) break;
      }
      if (lines.length > 3) { lines = lines.slice(0, 3); lines[2] = lines[2].replace(/[.,;:]?$/, "\u2026"); }
      var lh = Math.round(size * 1.12), y = H - PAD - lh * (lines.length - 1);
      ctx.textBaseline = "alphabetic";
      ctx.font = "700 28px Georgia, 'Times New Roman', serif";
      ctx.fillStyle = "#f2d6ba";
      ctx.fillText(c.label.toUpperCase(), PAD, y - size - 18);
      ctx.font = "700 " + size + "px Georgia, 'Times New Roman', serif";
      lines.forEach(function (line, n) {
        ctx.fillStyle = "#000"; ctx.fillText(line, PAD + 2, y + n * lh + 3);
        ctx.fillStyle = "#fff"; ctx.fillText(line, PAD, y + n * lh);
      });
      var blob = await new Promise(function (ok) { canvas.toBlob(ok, "image/jpeg", 0.86); });
      if (!blob) continue;
      await fetch("/review/cards/" + encodeURIComponent(c.id) + "?version=" + c.version, {
        method: "POST", headers: { "Content-Type": "image/jpeg", "X-CSRF": box.dataset.csrf }, body: blob
      });
    } catch (e) {}
  }
})();
"""
