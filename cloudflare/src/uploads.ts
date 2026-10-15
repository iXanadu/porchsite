/**
 * Photos from the person's phone. An assistant can't carry megabytes of image
 * through a tool call, so it asks for a one-time link instead, sends it to its
 * person, and they pick the photo and describe it. The link is the only key:
 * it works once, for 30 minutes. The photo is stored like any other image
 * (media.ts) and, like them, shows publicly only once a published item uses it.
 */
import { ApiError } from "./errors";
import * as media from "./media";

const TTL_MINUTES = 30;

export interface Upload {
  id: string;
  status: "waiting" | "done" | "expired";
  purpose: string;
  expires_at: string;
  image: string | null;
  alt: string | null;
}

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function hash(token: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface Row {
  id: string;
  purpose: string;
  expires_at: string;
  media: string | null;
  alt: string | null;
}

function shape(r: Row): Upload {
  const status = r.media ? "done" : r.expires_at < new Date().toISOString() ? "expired" : "waiting";
  return { id: r.id, status, purpose: r.purpose, expires_at: r.expires_at, image: r.media, alt: r.alt };
}

/** A new link. Returns the record and the secret path, which is shown once. */
export async function create(db: D1Database, actor: string, purpose: string): Promise<Upload & { path: string }> {
  const id = `upl_${b64url(crypto.getRandomValues(new Uint8Array(6)))}`;
  const token = b64url(crypto.getRandomValues(new Uint8Array(24)));
  const now = new Date();
  const expires = new Date(now.getTime() + TTL_MINUTES * 60_000).toISOString();
  await db
    .prepare("INSERT INTO uploads (id, token_hash, purpose, requested_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, await hash(token), purpose.slice(0, 200), actor, now.toISOString(), expires)
    .run();
  return { ...shape({ id, purpose, expires_at: expires, media: null, alt: null }), path: `/upload/${token}` };
}

export async function get(db: D1Database, id: string): Promise<Upload> {
  const r = await db.prepare("SELECT id, purpose, expires_at, media, alt FROM uploads WHERE id = ?").bind(id).first<Row>();
  if (!r) throw new ApiError(404, "not_found", `No upload ${id}.`);
  return shape(r);
}

/** The link's upload, if it can still be used. */
export async function open(db: D1Database, token: string): Promise<Upload | null> {
  const r = await db.prepare("SELECT id, purpose, expires_at, media, alt FROM uploads WHERE token_hash = ?").bind(await hash(token)).first<Row>();
  if (!r) return null;
  const u = shape(r);
  return u.status === "waiting" ? u : null;
}

/** Take the photo: check it, store it, close the link. */
export async function receive(db: D1Database, token: string, file: File | null, alt: string): Promise<Upload> {
  const u = await open(db, token);
  if (!u) throw new ApiError(410, "link_used", "This link has been used or has expired. Ask your assistant for a new one.");
  if (!alt.trim()) throw new ApiError(422, "invalid", "Please describe the photo in a few words, for people who can't see it.");
  if (!file || !file.size) throw new ApiError(422, "invalid", "Choose a photo first.");
  if (file.size > media.MAX_BYTES) throw new ApiError(422, "invalid", `That photo is over ${media.MAX_BYTES / 1024 / 1024} MB. Try a smaller copy.`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = media.sniff(bytes);
  if (!type) throw new ApiError(422, "invalid", "That isn't a JPEG, PNG or WebP photo. On an iPhone, choose it from Photos rather than Files.");
  const path = await media.store(db, bytes, type, `upload ${u.id}`);
  // Only the first arrival wins, so a double tap can't swap the photo.
  const done = await db
    .prepare("UPDATE uploads SET media = ?, alt = ?, used_at = ? WHERE id = ? AND media IS NULL")
    .bind(path, alt.trim().slice(0, 200), new Date().toISOString(), u.id)
    .run();
  if (done.meta.changes !== 1) throw new ApiError(410, "link_used", "This link has already been used.");
  return get(db, u.id);
}

/** Shrinks big photos on the phone before sending: faster, and under the size cap. */
export const SHRINK_JS = `
const form = document.querySelector("form"), input = form.querySelector("input[type=file]"), original = form.querySelector("input[name=original]"), btn = form.querySelector("button");
const MAX = 2400;
form.addEventListener("submit", async (e) => {
  const file = input.files[0];
  if (!file || original.checked || !window.createImageBitmap || !window.DataTransfer) return;
  e.preventDefault(); btn.disabled = true; btn.textContent = "Sending…";
  let image;
  try {
    image = await createImageBitmap(file);
    const scale = Math.min(1, MAX / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Picture resizing unavailable");
    context.fillStyle = "#fff"; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.85));
    if (!blob || blob.type !== "image/jpeg") throw new Error("Picture resizing unavailable");
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], "photo.jpg", { type: "image/jpeg" }));
    input.files = transfer.files;
  } catch (error) {
    // Keep the selected file: the native form still works without a canvas.
  } finally {
    if (image) image.close();
    form.submit();
  }
});`;
