/** Remove location metadata without decoding pixels or following EXIF pointers. */
import { Buffer } from "node:buffer";
import { ApiError } from "./errors";
type Edits = { out: Uint8Array | null; from: number; to: number };
const changes = (): Edits => ({out: null, from: 0, to: 0});
const ascii = (b: Uint8Array, i: number, s: string) => [...s].every((c, n) => b[i + n] === c.charCodeAt(0));
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
function edit(edits: Edits, b: Uint8Array, start: number, end: number, bytes: Uint8Array = empty) {
  if (end - start === bytes.length && bytes.every((v, i) => v === b[start + i])) return;
  edits.out ??= new Uint8Array(b.length);
  if (start > edits.from) edits.out.set(b.subarray(edits.from, start), edits.to);
  edits.to += start - edits.from;
  if (bytes.length) edits.out.set(bytes, edits.to);
  edits.to += bytes.length; edits.from = end;
}
function apply(b: Uint8Array, edits: Edits): Uint8Array {
  if (!edits.out) return b;
  edits.out.set(b.subarray(edits.from), edits.to);
  return edits.out.subarray(0, edits.to + b.length - edits.from);
}
function position(edits: Edits, at: number): number {
  return edits.out ? edits.to + at - edits.from : at;
}
// Header-only legacy pictures may be incomplete. Never pass through a damaged
// tail containing a possible metadata packet; reject it without exposing bytes.
function safeTail(b: Uint8Array, start: number, names: string[]): void {
  const view = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  for (const name of names) if (view.indexOf(name, start, "latin1") >= 0) bad();
}
// Adjacent discarded packets need one edit, even when a small file contains
// millions of empty comments. Keep the pass linear and its storage constant.
function discardedEnd(b: Uint8Array, end: number): number {
  while (end + 4 <= b.length && b[end] === 255) {
    const code = b[end + 1], length = (b[end + 2] << 8) | b[end + 3], next = end + 2 + length;
    if (length < 2 || next > b.length || (code !== 0xed && code !== 0xfe && code !== 0xe1)) break;
    if (code === 0xe1 && length >= 8 && ascii(b, end + 4, "Exif\0\0")) break;
    end = next;
  }
  return end;
}
function jpeg(b: Uint8Array): Uint8Array {
  const edits = changes();
  const view = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  let at = 2;
  while (at < b.length) {
    const start = b[at] === 255 ? at : view.indexOf("\xff", at, "latin1");
    if (start < 0) break;
    let marker = start + 1;
    while (marker < b.length && b[marker] === 255) marker++;
    if (marker >= b.length) break;
    const code = b[marker];
    if (code === 0 || code === 1 || (code >= 0xd0 && code <= 0xd9)) { at = marker + 1; continue; }
    const meta = code === 0xe1 || code === 0xed || code === 0xfe;
    if (marker + 2 >= b.length) { if (meta) bad(); break; }
    const length = (b[marker + 1] << 8) | b[marker + 2], end = marker + 1 + length;
    if (length < 2 || end > b.length) {
      if (meta) bad();
      safeTail(b, marker + 1, ["\xff\xe1", "\xff\xed", "\xff\xfe"]); break;
    }
    if (code === 0xe1) {
      const payload = b.subarray(marker + 3, end);
      const value = ascii(payload, 0, "Exif\0\0") ? orientation(payload) : null;
      let replacement = empty;
      if (value !== null) {
        replacement = new Uint8Array(36);
        replacement.set([255,225,0,34,69,120,105,102,0,0]); replacement.set(tiff(value), 10);
      }
      if (!replacement.length) { at = discardedEnd(b, end); edit(edits, b, start, at); continue; }
      edit(edits, b, start, end, replacement);
    } else if (code === 0xed || code === 0xfe) {
      at = discardedEnd(b, end); edit(edits, b, start, at); continue;
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
  const edits = changes();
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let at = 8;
  while (at + 8 <= b.length) {
    const name = v.getUint32(at + 4);
    const meta = name === 0x65584966 || name === 0x74455874 || name === 0x69545874 || name === 0x7a545874;
    const length = v.getUint32(at), end = at + 12 + length;
    const known = name === 0x49444154 || name === 0x49484452 || name === 0x49454e44 || name === 0x69434350 || meta;
    if (end > b.length || (!known && !/^[A-Za-z]{4}$/.test(String.fromCharCode(b[at+4],b[at+5],b[at+6],b[at+7])))) {
      if (meta) bad(); safeTail(b, at, ["eXIf", "tEXt", "iTXt", "zTXt"]); break;
    }
    if (meta) {
      const value = name === 0x65584966 ? orientation(b.subarray(at + 8, end - 4)) : null;
      edit(edits, b, at, end, value === null ? empty : pngExif(value));
    }
    at = end;
  }
  if (at < b.length) safeTail(b, at, ["eXIf", "tEXt", "iTXt", "zTXt"]);
  return apply(b, edits);
}
function webp(b: Uint8Array): Uint8Array {
  const edits = changes(), flags: number[] = [];
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let at = 12, hasExif = false, metadata = false;
  while (at + 8 <= b.length) {
    const name = v.getUint32(at);
    const length = v.getUint32(at + 4, true), end = at + 8 + length + (length % 2);
    const meta = name === 0x45584946 || name === 0x584d5020;
    if (end > b.length) {
      if (meta) bad(); safeTail(b, at, ["EXIF", "XMP "]); break;
    }
    if (name === 0x56503858 && length >= 10) flags.push(position(edits, at + 8));
    if (meta) {
      metadata = true;
      const value = name === 0x45584946 ? orientation(b.subarray(at + 8, at + 8 + length)) : null;
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
  let out = apply(b, edits);
  if (metadata) for (const offset of flags) {
    const value = (out[offset] & ~12) | (hasExif ? 8 : 0);
    if (value !== out[offset]) { if (out === b) out = b.slice(); out[offset] = value; }
  }
  if (out !== b) new DataView(out.buffer).setUint32(4, out.length - 8, true);
  return out;
}
export function stripLocation(b: Uint8Array, type: string): Uint8Array {
  const names = type === "image/jpeg" ? ["\xff\xe1", "\xff\xed", "\xff\xfe"] : type === "image/png" ? ["eXIf", "tEXt", "iTXt", "zTXt"] : type === "image/webp" ? ["EXIF", "XMP "] : [];
  const view = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  if (!names.some(name => view.indexOf(name, 0, "latin1") >= 0)) return b;
  return type === "image/jpeg" ? jpeg(b) : type === "image/png" ? png(b) : type === "image/webp" ? webp(b) : b;
}
