import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { toolTransport } from "../src/tool-transport";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import type { Env } from "../src/env";
import * as alerts from "../src/alerts";
import * as wire from "../src/push-crypto";
import * as owner from "../src/owner";
import * as content from "../src/content";
import * as approvals from "../src/approvals";
import * as assistantKeys from "../src/keys";
import { handle } from "../src/routes";
import { createToolHandlers } from "../src/mcp";
import { withToolContext } from "../src/tool-context";
import { SoftKey } from "./softkey";
import { decrypt } from "./push-receiver";
import vector from "../../spec/fixtures/web-push.json";
const e = env as unknown as Env,
  db = e.DB,
  origin = "https://site.example";
class Browser {
  jar = new Map<string, string>();
  req(path: string, init: RequestInit = {}) {
    return new Request(origin + path, {
      ...init,
      headers: {
        Cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "),
        ...(init.headers as Record<string, string>),
      },
    });
  }
  async at(path: string, init: RequestInit = {}) {
    const r = await handle(this.req(path, init), e);
    for (const h of r.headers.getSetCookie()) {
      const m = /^([^=;]+)=([^;]*)/.exec(h);
      if (m) this.jar.set(m[1], m[2]);
    }
    return r;
  }
  async post(path: string, value: any, csrf?: string) {
    return this.at(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        ...(csrf ? { "X-CSRF": csrf } : {}),
      },
      body: JSON.stringify(value),
    });
  }
  async options(path: string, value: any = {}) {
    const r = await this.post(path, value);
    expect(r.status, await r.clone().text()).toBe(200);
    return ((await r.json()) as any).options;
  }
}
const subscription = {
  endpoint: "https://fcm.googleapis.com/push/test",
  keys: { p256dh: vector.p256dh, auth: vector.auth },
  label: "Example phone",
};
async function setup(privateMode = true) {
  const b = new Browser(),
    key = await SoftKey.make();
  expect(
    (
      await b.post(
        "/setup/verify",
        await key.create(
          await b.options("/setup/options", { code: e.SETUP_CODE }),
          origin,
        ),
      )
    ).status,
  ).toBe(200);
  const site = await content.createItem(
      db,
      "assistant:test",
      "site",
      { title: "Hidden title", private: privateMode },
      undefined,
    ),
    a = await approvals.request(db, "assistant:test", [site.id], "");
  await approvals.decide(db, a.id, { site: { decision: "approve" } }, "");
  return { b, key };
}
async function enroll(b: Browser, endpoint = subscription.endpoint) {
  const r = await b.post(
    "/review/alerts/subscribe",
    { ...subscription, endpoint },
    await owner.csrf(b.req("/")),
  );
  expect(r.status, await r.clone().text()).toBe(200);
  return ((await r.json()) as any).id as string;
}
async function pending() {
  const item = await content.createItem(
    db,
    "assistant:test",
    "note",
    { text: "Example change", date: "2026-10-16" },
    undefined,
  );
  return approvals.request(db, "assistant:test", [item.id], "");
}
beforeEach(async () => {
  await alerts.drain();
  for (const t of [
    "alert_deliveries",
    "alert_subscriptions",
    "alert_keys",
    "reader_sessions",
    "reader_passkeys",
    "reader_invites",
    "readers",
    "owner_session_auth",
    "auth_operations",
    "sessions",
    "challenges",
    "passkeys",
    "owner",
    "recovery_codes",
    "private_approvals",
    "site_fields",
    "site_embed_sources",
    "approvals",
    "publishes",
    "live",
    "revisions",
    "items",
    "idempotency",
  ])
    await db.prepare(`DELETE FROM ${t}`).run();
  await db
    .prepare("UPDATE auth_state SET owner_epoch=0,private_floor=''")
    .run();
});
afterEach(async () => {
  await alerts.drain();
  vi.restoreAllMocks();
});
describe("owner approval alerts", () => {
  it("matches the RFC8291 example and decrypts it independently", async () => {
    const body = await wire.encrypt(
      new TextEncoder().encode(vector.plaintext),
      vector.p256dh,
      vector.auth,
      { privateKey: vector.sender, salt: wire.unb64(vector.salt) },
    );
    expect(wire.b64(body)).toBe(vector.ciphertext);
    expect(await decrypt(body, vector.receiver, vector.auth)).toBe(
      vector.plaintext,
    );
  });
  for (const url of [
    "http://fcm.googleapis.com/a",
    "https://127.0.0.1/a",
    "https://[::1]/a",
    "https://localhost/a",
    "https://fcm.googleapis.com:444/a",
    "https://@fcm.googleapis.com/a",
    "https://fcm.googleapis.com./a",
    "https://fcm.googleapis.com.evil.example/a",
    "https://notpush.apple.com/a",
    "https://push.apple.com/a",
    "https://notify.windows.com/a",
    "https://%66cm.googleapis.com/a",
    "https://xn--x.push.apple.com/a",
    "https://é.push.apple.com/a",
    "https://fcm.googleapis.com/#",
    "https://fcm.googleapis.com:/a",
  ])
    it(`refuses unsupported endpoint ${url}`, () => {
      expect(() => wire.endpoint(url)).toThrow();
    });
  for (const url of [
    "https://FCM.GOOGLEAPIS.COM:443/a",
    "https://updates.push.services.mozilla.com/a",
    "https://web.push.apple.com/a",
    "https://a.b.notify.windows.com/a",
  ])
    it(`accepts trusted endpoint ${url}`, () => {
      expect(wire.endpoint(url)).toMatch(/^https:/);
    });
  it("requires owner and CSRF; lists and removes devices without exposing endpoint secrets", async () => {
    const { b } = await setup(),
      visitor = new Browser();
    expect(
      (await visitor.post("/review/alerts/subscribe", subscription)).status,
    ).toBe(404);
    expect(
      (await b.post("/review/alerts/subscribe", subscription)).status,
    ).toBe(403);
    const id = await enroll(b),
      page = await (await b.at("/review/alerts")).text();
    expect(page).toContain("Example phone");
    expect(page).toContain("Added ");
    expect(page).toContain("Not used yet");
    expect(page).not.toContain(subscription.endpoint);
    expect(page).not.toContain(vector.auth);
    expect(
      (await b.at("/review")).headers.get("Content-Security-Policy"),
    ).toContain("worker-src 'self'");
    expect(
      (
        await b.post(
          "/review/alerts/remove",
          { id },
          await owner.csrf(b.req("/")),
        )
      ).status,
    ).toBe(200);
    expect(await alerts.devices(db)).toEqual([]);
  });
  it("refuses reader and assistant credentials as owner subscription authority", async () => {
    const { b } = await setup(),
      invite = await owner.createReaderInvite(db, "Reader"),
      reader = new Browser(),
      key = await SoftKey.make();
    await reader.post(
      `/invite/${invite.token}/verify`,
      await key.create(
        await reader.options(`/invite/${invite.token}/options`),
        origin,
      ),
    );
    expect(
      (await reader.post("/review/alerts/subscribe", subscription)).status,
    ).toBe(303);
    const assistant = await assistantKeys.create(db,"Example");
    expect(await assistantKeys.lookup(db,assistant.token)).not.toBeNull();
    const r = await new Browser().at("/review/alerts/key", {
      headers: { Authorization: `Bearer ${assistant.token}` },
    });
    expect(r.status).toBe(404);
    await enroll(b);
  });
  it("has one VAPID key, captures epoch and cleans subscriptions on passkey removal/recovery", async () => {
    const { b } = await setup(),
      both = await Promise.all([alerts.keys(db), alerts.keys(db)]);
    expect(both[0].public_key).toBe(both[1].public_key);
    await enroll(b);
    const identity = await alerts.identity(db, b.req("/"));
    await owner.removePasskey(db, identity.credential_id);
    expect(await alerts.devices(db)).toEqual([]);
    expect(
      (
        await b.post(
          "/review/alerts/subscribe",
          subscription,
          await owner.csrf(b.req("/")),
        )
      ).status,
    ).toBe(404);
  });
  it("encrypts only the fixed payload and batches once per request/device until review opens", async () => {
    const { b } = await setup();
    await enroll(b);
    const sent: any[] = [],
      transport = vi.fn(async (url: any, init: any) => {
        sent.push({ url, init });
        return new Response(null, { status: 201 });
      }) as unknown as typeof fetch;
    const a = await pending(), another = await pending();
    await Promise.all([
      alerts.sendApproval(db, a.id, transport),
      alerts.sendApproval(db, a.id, transport),
      alerts.sendApproval(db, another.id, transport),
    ]);
    expect(sent).toHaveLength(1);
    const message = JSON.parse(
      await decrypt(
        new Uint8Array(sent[0].init.body),
        vector.receiver,
        vector.auth,
      ),
    );
    expect(message).toEqual(alerts.payload("Hidden title", origin));
    expect(sent[0].init.redirect).toBe("manual");
    expect(sent[0].init.headers.Authorization).toMatch(/^vapid t=/);
    expect(sent[0].init.headers.Topic).toBeUndefined();
    await alerts.sendApproval(db, (await pending()).id, transport);
    expect(sent).toHaveLength(1);
    expect((await b.at("/review")).status).toBe(200);
    await alerts.sendApproval(db, (await pending()).id, transport);
    expect(sent).toHaveLength(2);
    await db
      .prepare("UPDATE alert_subscriptions SET last_claim_at=? ,opened_at=0")
      .bind(Date.now() - 300001)
      .run();
    await alerts.sendApproval(db, (await pending()).id, transport);
    expect(sent).toHaveLength(3);
  });
  it("removes410/404 subscriptions, refuses changed endpoints and never follows redirects", async () => {
    const { b } = await setup();
    for (const status of [410, 404]) {
      await enroll(b);
      await alerts.sendApproval(
        db,
        (await pending()).id,
        vi.fn(
          async () => new Response(null, { status }),
        ) as unknown as typeof fetch,
      );
      expect(await alerts.devices(db)).toEqual([]);
    }
    await enroll(b);
    const transport = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { Location: "http://127.0.0.1/" },
        }),
    );
    await alerts.sendApproval(
      db,
      (await pending()).id,
      transport as unknown as typeof fetch,
    );
    expect(transport).toHaveBeenCalledTimes(1);
    await db
      .prepare(
        "UPDATE alert_subscriptions SET endpoint='https://localhost/x',last_claim_at=0",
      )
      .run();
    await alerts.sendApproval(
      db,
      (await pending()).id,
      transport as unknown as typeof fetch,
    );
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("keeps private worker, manifest and icon exact routes free of content; misses remain blank", async () => {
    const { b } = await setup(),
      visitor = new Browser();
    for (const method of ["GET", "HEAD"]) {
      for (const path of [
        "/sw.js",
        "/manifest.webmanifest",
        "/app-icon-192.png",
        "/app-icon-512.png",
      ]) {
        const r = await visitor.at(path, { method });
        expect(r.status).toBe(200);
        expect(r.headers.has("Set-Cookie")).toBe(false);
        if (method === "HEAD") expect(await r.text()).toBe("");
      }
    }
    const manifest = (await (
      await visitor.at("/manifest.webmanifest")
    ).json()) as any;
    expect(manifest.name).toBe("Porchsite");
    expect(manifest.start_url).toBe("/login?next=/review");
    expect(manifest.id).toBe("/review");
    const named = await b.at("/manifest.webmanifest");
    expect(((await named.json()) as any).name).toBe("Hidden title");
    expect(named.headers.get("Cache-Control")).toBe(
      "private, no-store, no-transform",
    );
    const worker = await (await visitor.at("/sw.js")).text();
    expect(worker).not.toContain("Hidden title");
    expect(worker).not.toContain("addEventListener('fetch'");
    for (const path of [
      "/sw.js/x",
      "/manifest.webmanifest/x",
      "/app-icon-192.png/x",
    ]) {
      const r = await visitor.at(path);
      expect(r.status).toBe(404);
      expect(await r.text()).toBe(
        '<!doctype html><meta name="robots" content="noindex"><title></title><a href="/login?next=%2Freview">Sign in</a>',
      );
    }
  });
  it("keeps MCP approval bytes independent of absent/present/failing push", async () => {
    const { b } = await setup();
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("offline"));
    let baseline: string | undefined;
    for (const mode of ["absent", "present", "failing"]) {
      if (mode !== "absent") await enroll(b);
      if (mode === "present")
        fetcher.mockResolvedValue(new Response(null, { status: 201 }));
      else fetcher.mockRejectedValue(new Error("offline"));
      const item = await content.createItem(
        db,
        "assistant:test",
        "note",
        { text: "Example change", date: "2026-10-16" },
        undefined,
      );
      const result = await withToolContext({ client: "test", origin }, () =>
        createToolHandlers().get("approval_request")!({
          ids: [item.id],
          note: "",
        }),
      );
      await alerts.drain();
      const a = result.structuredContent as any;
      const normalized = JSON.stringify(result)
        .replaceAll(a.id, "REQUEST")
        .replaceAll(item.id, "ITEM")
        .replaceAll(a.created_at, "TIME");
      if (baseline === undefined) baseline = normalized;
      else expect(normalized).toBe(baseline);
      expect(Object.keys(a).some((k) => /alert|delivery/.test(k))).toBe(false);
    }
  });
});

it("recovery clears every device and stale captured enrollment cannot return", async () => {
  const { b } = await setup();
  await enroll(b);
  const code = "q".repeat(32);
  await owner.issueRecoveryCode(db, code);
  const recovered = new Browser(),
    key = await SoftKey.make();
  expect(
    (
      await recovered.post(
        "/recover/verify",
        await key.create(
          await recovered.options("/recover/options", { code }),
          origin,
        ),
      )
    ).status,
  ).toBe(200);
  expect(await alerts.devices(db)).toEqual([]);
  const wrapper = {
    prepare: db.prepare.bind(db),
    batch: async (statements: D1PreparedStatement[]) => {
      await db
        .prepare("UPDATE auth_state SET owner_epoch=owner_epoch+1 WHERE id=1")
        .run();
      return db.batch(statements);
    },
  } as D1Database;
  await expect(
    alerts.subscribe(
      wrapper,
      recovered.req("/review/alerts/subscribe"),
      subscription,
      origin,
    ),
  ).rejects.toThrow();
  expect(await alerts.devices(db)).toEqual([]);
});

it("imports schedule only a committed request and failed imports do not send", async () => {
  const { b } = await setup();
  await enroll(b);
  const transport = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(null, { status: 201 }));
  const doc = {
    porchsite_import: 1,
    from: "Example",
    note: "",
    items: [
      { kind: "note", data: { text: "Imported change", date: "2026-10-16" } },
    ],
  };
  const form = () => {
    const f = new FormData();
    f.set("csrf", "");
    f.set(
      "file",
      new File([JSON.stringify(doc)], "changes.json", {
        type: "application/json",
      }),
    );
    return f;
  };
  const good = form();
  good.set("csrf", await owner.csrf(b.req("/")));
  expect(
    (await b.at("/review/import", { method: "POST", body: good })).status,
  ).toBe(303);
  await alerts.drain();
  expect(transport).toHaveBeenCalledTimes(1);
  doc.items[0].data.date = "invalid";
  const bad = form();
  bad.set("csrf", await owner.csrf(b.req("/")));
  await b.at("/review/import", { method: "POST", body: bad });
  await alerts.drain();
  expect(transport).toHaveBeenCalledTimes(1);
});

it("keeps actual HTTP approval bytes independent of push state", async () => {
  const { b } = await setup();
  const network = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(null, { status: 201 }));
  let baseline: string | undefined;
  for (const mode of ["absent", "present", "failing"]) {
    if (mode !== "absent") await enroll(b);
    if (mode === "failing") network.mockRejectedValue(new Error("offline"));
    const item = await content.createItem(
      db,
      "assistant:test",
      "note",
      { text: "Example change", date: "2026-10-16" },
      undefined,
    );
    const ctx = Object.assign(createExecutionContext(), {
      props: { client: "test", origin },
    });
    const r = await toolTransport(
      new Request(origin + "/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: {
            name: "approval_request",
            arguments: { ids: [item.id], note: "" },
          },
        }),
      }),
      e,
      ctx,
    );
    expect(r.status).toBe(200);
    await alerts.drain();
    const text = await r.text(),
      a = JSON.parse(text).result.structuredContent;
    const normalized = text
      .replaceAll(a.id, "REQUEST")
      .replaceAll(item.id, "ITEM")
      .replaceAll(a.created_at, "TIME");
    if (baseline === undefined) baseline = normalized;
    else expect(normalized).toBe(baseline);
    expect(Object.keys(a).some((k) => /alert|delivery/.test(k))).toBe(false);
  }
});

it("signs an audience-bound ES256 VAPID token and rejects malformed subscription keys", async () => {
  const { b } = await setup();
  const key = await alerts.keys(db),
    auth = await wire.authorization(
      key.private_key,
      key.public_key,
      subscription.endpoint,
      origin,
      1000000,
    ),
    jwt = auth.slice(8).split(", k=")[0],
    parts = jwt.split(".");
  const claims = JSON.parse(new TextDecoder().decode(wire.unb64(parts[1])));
  expect(claims).toEqual({
    aud: "https://fcm.googleapis.com",
    exp: 44200,
    sub: origin,
  });
  const publicKey = await crypto.subtle.importKey(
    "raw",
    wire.unb64(key.public_key),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  expect(
    await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      wire.unb64(parts[2]),
      new TextEncoder().encode(parts[0] + "." + parts[1]),
    ),
  ).toBe(true);
  for (const keys of [
    { p256dh: "bad", auth: vector.auth },
    { p256dh: vector.p256dh, auth: "AA" },
    { p256dh: wire.b64(new Uint8Array(65).fill(4)), auth: vector.auth },
  ])
    expect(
      (
        await b.post(
          "/review/alerts/subscribe",
          { ...subscription, keys },
          await owner.csrf(b.req("/")),
        )
      ).status,
    ).toBe(422);
  expect(await alerts.devices(db)).toEqual([]);
});

it("does not hold an approval response open for a push that times out", async () => {
  const { b } = await setup();
  await enroll(b);
  let started = false,
    aborted = false;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    started = true;
    return new Promise((_resolve, reject) => {
      init!.signal!.addEventListener(
        "abort",
        () => {
          aborted = true;
          reject(new Error("timeout"));
        },
        { once: true },
      );
    });
  });
  const item = await content.createItem(
    db,
    "assistant:test",
    "note",
    { text: "Example change", date: "2026-10-16" },
    undefined,
  );
  const answer = await withToolContext({ client: "test", origin }, () =>
    createToolHandlers().get("approval_request")!({ ids: [item.id], note: "" }),
  );
  expect(answer.structuredContent.status).toBe("pending");
  expect(aborted).toBe(false);
  await alerts.drain();
  expect(started).toBe(true);
  expect(aborted).toBe(true);
});

// Shared wire/markup fixtures keep the editions aligned outside look rendering.
import delta from "../../spec/fixtures/approval-alerts.json";
for (const row of delta.endpoints)
  it(`canonicalizes the browser endpoint ${row.input}`, () => {
    expect(wire.endpoint(row.input)).toBe(row.canonical);
    expect(wire.endpoint(row.input)).toBe(new URL(row.input).href);
  });

it("stores canonical endpoints once and fingerprints their serialized target", async () => {
  const { b } = await setup();
  const row = delta.endpoints[1];
  await enroll(b, row.input);
  await enroll(b, row.canonical);
  const stored = await db.prepare("SELECT endpoint FROM alert_subscriptions").all<any>();
  expect(stored.results).toEqual([{ endpoint: row.canonical }]);
  const expected = wire.b64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode([row.canonical, vector.p256dh, vector.auth].join("\n")))));
  expect((await alerts.devices(db))[0].fingerprint).toBe(expected);
});
for (const cut of delta.cuts)
  it(`cuts manifest names and labels by UTF-16 units (${cut.short_name.length})`, async () => {
    const { b } = await setup();
    const site = await content.updateItem(db, "assistant:test", "site", 1, { title: cut.title });
    const request = await approvals.request(db, "assistant:test", [site.id], "");
    await approvals.decide(db, request.id, { site: { decision: "approve" } }, "");
    const manifest = await (await b.at("/manifest.webmanifest")).json() as any;
    expect(manifest.name).toBe(cut.title);
    expect(manifest.short_name).toBe(cut.short_name);
    const r = await b.post("/review/alerts/subscribe", { ...subscription, label: cut.label }, await owner.csrf(b.req("/")));
    expect(r.status).toBe(200);
    expect((await alerts.devices(db))[0].label).toBe(cut.saved_label);
  });

it("matches the shared review block markup and marks only the current device", async () => {
  const { b } = await setup();
  const block = async (on: boolean) => {
    const page = await (await b.at("/review")).text();
    let found = page.match(/<section id="approval-alerts"[^]*?<\/section>/)![0];
    found = found.replace(await owner.csrf(b.req("/")), "CSRF");
    if (on) {
      const [device] = await alerts.devices(db);
      found = found.replace(device.id, "DEVICE").replace(device.fingerprint, "FINGERPRINT");
    }
    expect(found).toBe(on ? delta.controls.on : delta.controls.off);
  };
  await block(false);
  await enroll(b);
  await block(true);
  expect(await (await b.at("/review/alerts")).text()).toContain("Example phone (this device)");
  b.jar.delete(alerts.DEVICE_COOKIE);
  expect(await (await b.at("/review/alerts")).text()).not.toContain("Example phone (this device)");
});

it("only an owner opening review on this device resets batching", async () => {
  const { b } = await setup();
  const id = await enroll(b), invite = await owner.createReaderInvite(db, "Reader"), reader = new Browser(), key = await SoftKey.make();
  await reader.post(`/invite/${invite.token}/verify`, await key.create(await reader.options(`/invite/${invite.token}/options`), origin));
  const assistant = await assistantKeys.create(db, "Example"), visitor = new Browser();
  for (const browser of [visitor, reader]) browser.jar.set(alerts.DEVICE_COOKIE, id);
  const transport = vi.fn(async () => new Response(null, { status: 201 })) as unknown as typeof fetch;
  await alerts.sendApproval(db, (await pending()).id, transport);
  const before = await db.prepare("SELECT opened_at FROM alert_subscriptions WHERE id=?").bind(id).first();
  expect((await visitor.at("/review")).status).toBe(404);
  expect((await visitor.at("/review", { headers: { Authorization: `Bearer ${assistant.token}` } })).status).toBe(404);
  expect((await reader.at("/review")).status).toBe(303);
  expect(await db.prepare("SELECT opened_at FROM alert_subscriptions WHERE id=?").bind(id).first()).toEqual(before);
  await alerts.sendApproval(db, (await pending()).id, transport);
  expect(transport).toHaveBeenCalledTimes(1);
  expect((await b.at("/review")).status).toBe(200);
  await alerts.sendApproval(db, (await pending()).id, transport);
  expect(transport).toHaveBeenCalledTimes(2);
});
for (const elapsed of [299999, 300000, 300001])
  it(`batches at the ${elapsed}ms boundary`, async () => {
    const { b } = await setup();
    await enroll(b);
    const request = await pending(), at = Date.now();
    await db.prepare("UPDATE alert_subscriptions SET last_claim_at=?,opened_at=0").bind(at).run();
    vi.spyOn(Date, "now").mockReturnValue(at + elapsed);
    const transport = vi.fn(async () => new Response(null, { status: 201 })) as unknown as typeof fetch;
    await alerts.sendApproval(db, request.id, transport);
    expect(transport).toHaveBeenCalledTimes(elapsed < 300000 ? 0 : 1);
  });

it("keeps conditional GET/HEAD asset responses role-safe and never reuses a branded manifest", async () => {
  const { b } = await setup(), visitor = new Browser();
  for (const browser of [b, visitor]) for (const path of ["/sw.js", "/manifest.webmanifest", "/app-icon-192.png", "/app-icon-512.png"]) {
    const baseline = await browser.at(path), bytes = await baseline.arrayBuffer();
    for (const method of ["GET", "HEAD"]) {
      const response = await browser.at(path, { method, headers: { "If-None-Match": '"owner-cached"', "If-Modified-Since": "Wed, 01 Jan 2031 00:00:00 GMT" } });
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe(baseline.headers.get("Content-Type"));
      expect(response.headers.get("Cache-Control")).toBe(baseline.headers.get("Cache-Control"));
      const body = new Uint8Array(await response.arrayBuffer());
      expect(body).toEqual(method === "HEAD" ? new Uint8Array() : new Uint8Array(bytes));
      if (path === "/manifest.webmanifest" && method === "GET") expect(JSON.parse(new TextDecoder().decode(body)).name).toBe(browser === b ? "Hidden title" : "Porchsite");
    }
  }
});

it("serializes remove versus the send claim without resurrecting a device", async () => {
  const { b } = await setup();
  let id = await enroll(b);
  const transport = vi.fn(async () => new Response(null, { status: 201 })) as unknown as typeof fetch;
  const wrapper = { prepare: db.prepare.bind(db), batch: async (statements: D1PreparedStatement[]) => {
    expect((await b.post("/review/alerts/remove", { id }, await owner.csrf(b.req("/")))).status).toBe(200);
    return db.batch(statements);
  } } as D1Database;
  await alerts.sendApproval(wrapper, (await pending()).id, transport);
  expect(transport).not.toHaveBeenCalled();
  expect(await alerts.devices(db)).toEqual([]);
  id = await enroll(b);
  const request = await pending();
  await alerts.sendApproval(db, request.id, (async () => {
    expect((await b.post("/review/alerts/remove", { id }, await owner.csrf(b.req("/")))).status).toBe(200);
    return new Response(null, { status: 201 });
  }) as typeof fetch);
  await alerts.sendApproval(db, request.id, transport);
  expect(transport).not.toHaveBeenCalled();
  expect(await alerts.devices(db)).toEqual([]);
});

it("prunes at most 500 old deliveries and never retries a request past retention", async () => {
  const { b } = await setup(), id = await enroll(b), request = await pending();
  await db.prepare("UPDATE approvals SET created_at='2000-01-01T00:00:00.000Z' WHERE id=?").bind(request.id).run();
  await db.prepare("WITH RECURSIVE n(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i<500) INSERT INTO alert_deliveries(request_id,subscription_id,claim,attempted,created_at) SELECT 'old-'||i,?,'old-'||i,1,0 FROM n").bind(id).run();
  await db.prepare("INSERT INTO alert_deliveries VALUES('recent',?,'recent',1,?)").bind(id, Date.now()).run();
  const transport = vi.fn() as unknown as typeof fetch;
  await alerts.sendApproval(db, request.id, transport);
  expect(transport).not.toHaveBeenCalled();
  expect((await db.prepare("SELECT count(*) AS n FROM alert_deliveries").first<any>())!.n).toBe(2);
  expect(await db.prepare("SELECT 1 FROM alert_deliveries WHERE claim='recent'").first()).not.toBeNull();
  await alerts.sendApproval(db, request.id, transport);
  expect((await db.prepare("SELECT count(*) AS n FROM alert_deliveries").first<any>())!.n).toBe(1);
  expect(transport).not.toHaveBeenCalled();
});

it("launches Home Screen apps through reachable sign-in with or without an owner session", async () => {
  const { b, key } = await setup(), visitor = new Browser();
  expect((await visitor.at("/review")).status).toBe(404);
  for (const browser of [visitor, b]) {
    const manifest = await (await browser.at("/manifest.webmanifest")).json() as any;
    expect(manifest.start_url).toBe("/login?next=/review");
    expect(manifest.id).toBe("/review");
    expect(manifest.name).toBe(browser === visitor ? "Porchsite" : "Hidden title");
    const response = await browser.at(manifest.start_url), page = await response.text();
    expect(response.status).toBe(200);
    expect(page).toContain("Sign in with passkey");
    expect(page).toContain('else location.href = "/review"');
    expect(page).not.toContain("Hidden title");
    const login = await browser.options("/login/options");
    expect((await browser.post("/login/verify", await key.get(login, origin))).status).toBe(200);
    expect((await browser.at("/review")).status).toBe(200);
  }
});
it("uses the sign-in launch URL for a public site's manifests too", async () => {
  const { b } = await setup(false);
  for (const browser of [new Browser(), b]) {
    const manifest = await (await browser.at("/manifest.webmanifest")).json() as any;
    expect(manifest.name).toBe("Hidden title");
    expect(manifest.start_url).toBe("/login?next=/review");
    expect(manifest.id).toBe("/review");
  }
});
