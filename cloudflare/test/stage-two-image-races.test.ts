// Both legal same-hash schedules must preserve the served content bytes.
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { imageAdd } from "../src/image-add";
import * as media from "../src/media";

it.each(["upload-first", "batch-first"])("preserves bytes when %s wins the same-hash race", async schedule => {
  const db = (env as unknown as Env).DB;
  const bytes = new Uint8Array(1_500_000);
  const salt = schedule === "upload-first" ? 1 : 2;
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i + salt) % 251;
  bytes.set([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,salt,0,0,0,1]);
  const encoded = bytes.toBase64();
  const original = db.batch.bind(db);
  // Pause the first writer after its absence lookup but before its atomic
  // batch, then let the other real writer commit the same content first.
  const spy = vi.spyOn(db, "batch").mockImplementation(async statements => {
    spy.mockRestore();
    if (schedule === "upload-first") await media.store(db, bytes, "image/png", "fixture");
    else await imageAdd(db, "assistant:test", undefined, [encoded]);
    return original(statements);
  });
  let path: string;
  try {
    path = schedule === "upload-first"
      ? (await imageAdd(db, "assistant:test", undefined, [encoded])).images![0].image
      : await media.store(db, bytes, "image/png", "fixture");
  } finally { spy.mockRestore(); }
  const response = await media.serve(db, path.slice("/media/".length), false);
  expect(response).not.toBeNull();
  const served = new Uint8Array(await response!.arrayBuffer());
  expect(served.byteLength).toBe(bytes.byteLength);
  expect(served.every((value, i) => value === bytes[i])).toBe(true);
});
