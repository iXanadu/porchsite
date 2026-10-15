/** Remove location metadata without decoding pixels or following EXIF pointers. */
import { Buffer } from "node:buffer";
import { ApiError } from "./errors";
type Edit = { start: number; end: number; bytes: Uint8Array };
const ascii = (b: Uint8Array, i: number, s: string) => [...s].every((c, n) => b[i + n] === c.charCodeAt(0));
const u32 = (b: Uint8Array, i: number, little = false) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(i, little);
const bad = () => { throw new ApiError(422, "invalid", "The picture's metadata is damaged. Try a fresh copy."); };
const empty = new Uint8Array();
function orientation(bytes: Uint8Array): number | null {
  const b = ascii(bytes, 0, "Exif\0\0") ? bytes.subarray(6) : bytes;
  if (b.length < 8 || (!ascii(b, 0, "II") && !ascii(b, 0, "MM"))) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength), le = b[0] === 73;
  if (v.getUint16(2, le) !== 42) return null;
  const at = v.getUint32(4, le);
  if (at < 8 || at > b.length - 2) return null;
  const count = v.getUint16(at, le);
  if (count > 64 || at + 2 + count * 12 + 4 > b.length) return null;
  for (let n = 0; n < count; n++) {
    const i = at + 2 + n * 12;
    if (v.getUint16(i, le) === 0x112 && v.getUint16(i + 2, le) === 3 && v.getUint32(i + 4, le) === 1) {
      const value = v.getUint16(i + 8, le);
      if (value >= 1 && value <= 8) return value;
    }
  }
  return null;
}
function tiff(value: number): Uint8Array {
  return new Uint8Array([73,73,42,0,8,0,0,0,1,0,18,1,3,0,1,0,0,0,value,0,0,0,0,0,0,0]);
}
function edit(edits: Edit[], b: Uint8Array, start: number, end: number, bytes: Uint8Array = empty) {
  if (end - start === bytes.length && bytes.every((v, i) => v === b[start + i])) return;
  edits.push({start, end, bytes});
}
function apply(b: Uint8Array, edits: Edit[]): Uint8Array {
  if (!edits.length) return b;
  edits.sort((a, z) => a.start - z.start);
  const out = new Uint8Array(b.length + edits.reduce((n, e) => n + e.bytes.length - (e.end - e.start), 0));
  let from = 0, to = 0;
  for (const e of edits) {
    out.set(b.subarray(from, e.start), to); to += e.start - from;
    out.set(e.bytes, to); to += e.bytes.length; from = e.end;
  }
  out.set(b.subarray(from), to);
  return out;
}
// Header-only legacy pictures may be incomplete. Never pass through a damaged
// tail containing a possible metadata packet; reject it without exposing bytes.
function safeTail(b: Uint8Array, start: number, names: string[]): void {
  const view = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  for (const name of names) if (view.indexOf(name, start, "latin1") >= 0) bad();
}
function jpeg(b: Uint8Array): Uint8Array {
  const edits: Edit[] = [];
  const view = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  let at = 2, segments = 0;
  while (at < b.length) {
    const start = view.indexOf("\xff", at, "latin1");
    if (start < 0) break;
    let marker = start + 1;
    while (marker < b.length && b[marker] === 255) { if (marker - start > 4096) bad(); marker++; }
    if (marker >= b.length) break;
    const code = b[marker];
    if (code === 0 || code === 1 || (code >= 0xd0 && code <= 0xd9)) { at = marker + 1; continue; }
    if (++segments > 4096) bad();
    const meta = code === 0xe1 || code === 0xed || code === 0xfe;
    if (marker + 2 >= b.length) { if (meta) bad(); break; }
    const length = (b[marker + 1] << 8) | b[marker + 2], end = marker + 1 + length;
    if (length < 2 || end > b.length) {
      if (meta) bad();
      safeTail(b, marker + 1, ["\xff\xe1", "\xff\xed", "\xff\xfe"]); break;
    }
    const payload = b.subarray(marker + 3, end);
    if (code === 0xe1) {
      const value = ascii(payload, 0, "Exif\0\0") ? orientation(payload) : null;
      let replacement = empty;
      if (value !== null) {
        replacement = new Uint8Array(36);
        replacement.set([255,225,0,34,69,120,105,102,0,0]); replacement.set(tiff(value), 10);
      }
      edit(edits, b, start, end, replacement);
    } else if (code === 0xed || code === 0xfe) {
      edit(edits, b, start, end);
    }
    at = end;
  }
  return apply(b, edits);
}
function crc(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const v of b) { c ^= v; for (let bit = 0; bit < 8; bit++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); }
  return (c ^ 0xffffffff) >>> 0;
}
function pngExif(value: number): Uint8Array {
  const out = new Uint8Array(38); new DataView(out.buffer).setUint32(0, 26);
  out.set([101,88,73,102], 4); out.set(tiff(value), 8);
  new DataView(out.buffer).setUint32(34, crc(out.subarray(4, 34))); return out;
}
function png(b: Uint8Array): Uint8Array {
  const edits: Edit[] = [];
  let at = 8, chunks = 0;
  while (at + 8 <= b.length) {
    if (++chunks > 4096) bad();
    const name = String.fromCharCode(...b.subarray(at + 4, at + 8));
    const meta = ["eXIf", "tEXt", "iTXt", "zTXt"].includes(name);
    const length = u32(b, at), end = at + 12 + length;
    if (end > b.length || !/^[A-Za-z]{4}$/.test(name)) {
      if (meta) bad(); safeTail(b, at, ["eXIf", "tEXt", "iTXt", "zTXt"]); break;
    }
    if (meta) {
      const value = name === "eXIf" ? orientation(b.subarray(at + 8, end - 4)) : null;
      edit(edits, b, at, end, value === null ? empty : pngExif(value));
    }
    at = end;
  }
  if (at < b.length) safeTail(b, at, ["eXIf", "tEXt", "iTXt", "zTXt"]);
  return apply(b, edits);
}
function webp(b: Uint8Array): Uint8Array {
  const edits: Edit[] = [], flags: number[] = [];
  let at = 12, chunks = 0, hasExif = false, metadata = false;
  while (at + 8 <= b.length) {
    if (++chunks > 4096) bad();
    const name = String.fromCharCode(...b.subarray(at, at + 4));
    const length = u32(b, at + 4, true), end = at + 8 + length + (length % 2);
    const meta = name === "EXIF" || name === "XMP ";
    if (end > b.length || !/^[A-Za-z0-9 ]{4}$/.test(name)) {
      if (meta) bad(); safeTail(b, at, ["EXIF", "XMP "]); break;
    }
    if (name === "VP8X" && length >= 10) flags.push(at + 8);
    if (meta) {
      metadata = true;
      const value = name === "EXIF" ? orientation(b.subarray(at + 8, at + 8 + length)) : null;
      let replacement = empty;
      if (value !== null) {
        hasExif = true; replacement = new Uint8Array(34);
        replacement.set([69,88,73,70,26,0,0,0]); replacement.set(tiff(value), 8);
      }
      edit(edits, b, at, end, replacement);
    }
    at = end;
  }
  if (at < b.length) safeTail(b, at, ["EXIF", "XMP "]);
  if (metadata) for (const offset of flags) edit(edits, b, offset, offset + 1, new Uint8Array([(b[offset] & ~12) | (hasExif ? 8 : 0)]));
  const out = apply(b, edits);
  if (out !== b) new DataView(out.buffer).setUint32(4, out.length - 8, true);
  return out;
}
export function stripLocation(b: Uint8Array, type: string): Uint8Array {
  return type === "image/jpeg" ? jpeg(b) : type === "image/png" ? png(b) : type === "image/webp" ? webp(b) : b;
}
