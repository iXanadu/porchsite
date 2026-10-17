import { invalidation } from "./public-artifacts";
/**
 * Share cards (SPEC §5): the picture a link to an entry shows when shared,
 * its photo with its title over it in large type. The owner's browser draws
 * them (CARD_JS, on /review), so the site itself does no image work: it lists
 * the published entries whose card is missing or older than the entry, and
 * keeps the JPEGs the browser sends back. Port-matched:
 * server/server/app/sharecards.py (the same script, byte for byte).
 */
import { ApiError } from "./errors";
import { LOCAL, size, sniff, store } from "./media";
import { liveView } from "./site";
import { streams } from "./theme";

export const CARD_W = 1200;
export const CARD_H = 630;
const MAX = 800 * 1024;

export interface Wanted {
  id: string;
  version: number;
  title: string;
  label: string;
  photo: string;
}

/** Published entries whose card is missing or was drawn for an older version. */
export async function missing(db: D1Database, host: string): Promise<Wanted[]> {
  const v = await liveView(db);
  const versions = new Map(
    (await db.prepare("SELECT item_id, version FROM live WHERE kind = 'entry'").all<{ item_id: string; version: number }>()).results.map((r) => [r.item_id, r.version]),
  );
  const have = new Map(
    (await db.prepare("SELECT item_id, version FROM share_cards").all<{ item_id: string; version: number }>()).results.map((r) => [r.item_id, r.version]),
  );
  const st = streams(v.site);
  const out: Wanted[] = [];
  for (const e of v.entries) {
    const version = versions.get(e.id);
    if (e.external_url || version === undefined || have.get(e.id) === version) continue;
    const stream = st.find((x) => x.id === e.stream);
    const photo = String(e.cover || v.site.share_image || v.site.hero || "");
    out.push({ id: e.id, version, title: String(e.title ?? ""), label: stream ? `${stream.nav_label} · ${host}` : host, photo: LOCAL.test(photo) ? photo : "" });
  }
  return out;
}

/** Keep the card the owner's browser drew for this entry at this version. */
export async function save(db: D1Database, id: string, version: number, bytes: Uint8Array): Promise<string> {
  const live = await db.prepare("SELECT version FROM live WHERE item_id = ? AND kind = 'entry'").bind(id).first<{ version: number }>();
  if (!live || live.version !== version) throw new ApiError(409, "not_current", "That entry isn't published at that version.");
  if (bytes.length > MAX || sniff(bytes) !== "image/jpeg") throw new ApiError(422, "invalid", "A share card is a JPEG of at most 800 KB.");
  const [w, h] = size(bytes);
  if (w !== CARD_W || h !== CARD_H) throw new ApiError(422, "invalid", `A share card is ${CARD_W} x ${CARD_H} pixels.`);
  const path = await store(db, bytes, "image/jpeg", `share card ${id}`);
  await db.batch([...invalidation(db), db
    .prepare("INSERT INTO share_cards (item_id, version, name, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (item_id) DO UPDATE SET version = excluded.version, name = excluded.name, created_at = excluded.created_at")
    .bind(id, version, path.slice("/media/".length), new Date().toISOString())]);
  return path;
}

/**
 * The owner's pages run this: draw each missing card on a canvas and send it
 * back. An element #share-cards carries the CSRF token. Quiet: a failure only
 * means the entry keeps its photo as its share picture until next time.
 */
export const CARD_JS = `(async function () {
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
    text.split(/\\s+/).forEach(function (word) {
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
      if (lines.length > 3) { lines = lines.slice(0, 3); lines[2] = lines[2].replace(/[.,;:]?$/, "\\u2026"); }
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
`;
