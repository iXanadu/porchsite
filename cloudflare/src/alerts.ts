import {dailyAccess} from './daily-limit';
/** Owner device settings and best-effort post-commit delivery. No MCP controls. */
import { waitUntil } from "cloudflare:workers";
import { ApiError } from "./errors";
import * as wire from "./push-crypto";
export const DEVICE_COOKIE = "__Host-sk_alertdevice";
export function cookie(req: Request, name = DEVICE_COOKIE) {
  const value = (
    (req.headers.get("Cookie") ?? "")
      .split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith(name + "="))
      ?.slice(name.length + 1) ?? ""
  );
  try { return decodeURIComponent(value); } catch { return ""; }
}
const hash = async (s: string) =>
  wire.b64(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
    ),
  );
const AUTH = `EXISTS (SELECT 1 FROM auth_state a JOIN owner_session_auth m ON m.epoch=a.owner_epoch JOIN sessions s ON s.token_hash=m.token_hash JOIN passkeys p ON p.id=m.credential_id WHERE a.id=1 AND m.token_hash=? AND m.credential_id=? AND m.epoch=? AND s.expires_at>?)`;
export async function identity(db: D1Database, req: Request) {
 return dailyAccess(async()=>{
  const token = await hash(cookie(req, "__Host-sk_owner")),
    at = new Date().toISOString();
  const row = await db
    .prepare(
      `SELECT m.credential_id,m.epoch FROM owner_session_auth m JOIN auth_state a ON a.id=1 AND a.owner_epoch=m.epoch JOIN passkeys p ON p.id=m.credential_id JOIN sessions s ON s.token_hash=m.token_hash WHERE m.token_hash=? AND s.expires_at>?`,
    )
    .bind(token, at)
    .first<any>();
  if (!row)
    throw new ApiError(
      403,
      "owner_required",
      "Sign out and sign in again before turning alerts on.",
    );
  return {
    token,
    credential_id: row.credential_id as string,
    epoch: row.epoch as number,
  };
 });
}
const authArgs = (i: {
  token: string;
  credential_id: string;
  epoch: number;
}) => [i.token, i.credential_id, i.epoch, new Date().toISOString()];
export async function keys(db: D1Database) {
  let row = await db
    .prepare("SELECT private_key,public_key FROM alert_keys WHERE id=1")
    .first<any>();
  if (!row) {
    const pair = await wire.keyPair();
    await db
      .prepare(
        "INSERT OR IGNORE INTO alert_keys(id,private_key,public_key) VALUES(1,?,?)",
      )
      .bind(pair.private_key, pair.public_key)
      .run();
    row = await db
      .prepare("SELECT private_key,public_key FROM alert_keys WHERE id=1")
      .first<any>();
  }
  return row as { private_key: string; public_key: string };
}
export async function subscribe(
  db: D1Database,
  req: Request,
  value: any,
  origin: string,
) {
 return dailyAccess(async()=>{
  const who = await identity(db, req);
  let endpoint: string;
  try {
    endpoint = wire.endpoint(value?.endpoint);
    await wire.publicKey(value?.keys?.p256dh);
    if (wire.unb64(value?.keys?.auth).length !== 16) throw new Error();
  } catch {
    throw new ApiError(
      422,
      "invalid_subscription",
      "This browser's alert subscription is not supported. Try again.",
    );
  }
  const site = new URL(origin);
  if (site.protocol !== "https:" || site.username || site.password)
    throw new ApiError(
      422,
      "invalid_origin",
      "Alerts need this site's HTTPS address.",
    );
  const id = crypto.randomUUID(),
    at = Date.now(),
    label =
      typeof value.label === "string"
        ? wire.u16slice(value.label.trim(), 80)
        : "Browser";
  const results = await db.batch([
    db
      .prepare(
        `DELETE FROM alert_subscriptions WHERE (endpoint=? OR id=?) AND ${AUTH}`,
      )
      .bind(endpoint, cookie(req), ...authArgs(who)),
    db
      .prepare(
        `INSERT INTO alert_subscriptions(id,endpoint,credential_id,epoch,p256dh,auth,origin,label,created_at) SELECT ?,?,?,?,?,?,?,?,? WHERE ${AUTH}`,
      )
      .bind(
        id,
        endpoint,
        who.credential_id,
        who.epoch,
        value.keys.p256dh,
        value.keys.auth,
        site.origin,
        label || "Browser",
        at,
        ...authArgs(who),
      ),
  ]);
  if (results[1].meta.changes !== 1)
    throw new ApiError(
      403,
      "owner_required",
      "Sign in again before turning alerts on.",
    );
  return id;
 });
}
export async function remove(db: D1Database, req: Request, id: string) {
 return dailyAccess(async()=>{
  const who = await identity(db, req);
  await db
    .prepare(`DELETE FROM alert_subscriptions WHERE id=? AND ${AUTH}`)
    .bind(id, ...authArgs(who))
    .run();
 });
}
export async function devices(db: D1Database) {
  const rows = await db
    .prepare(
      `SELECT s.* FROM alert_subscriptions s JOIN passkeys p ON p.id=s.credential_id JOIN auth_state a ON a.id=1 AND a.owner_epoch=s.epoch ORDER BY s.created_at,s.id`,
    )
    .all<any>();
  return Promise.all(
    rows.results.map(async (row) => ({
      id: row.id as string,
      label: row.label as string,
      created_at: row.created_at as number,
      last_used_at: row.last_used_at as number | null,
      fingerprint: await hash([row.endpoint, row.p256dh, row.auth].join("\n")),
    })),
  );
}
export async function opened(db: D1Database, req: Request) {
 return dailyAccess(async()=>{
  await db
    .prepare(
      "UPDATE alert_subscriptions SET opened_at=MAX(?,last_claim_at+1) WHERE id=?",
    )
    .bind(Date.now(), cookie(req))
    .run();
 });
}
export function payload(title: string, origin: string) {
  return {
    message: "Your site has a change waiting for you",
    title: title || "Porchsite",
    url: new URL("/review", origin).href,
  };
}
/** Test entrypoints may inject a transport; no environment or request can. */
export async function sendApproval(
  db: D1Database,
  requestId: string,
  transport: typeof fetch = fetch,
) {
  const cutoff = Date.now() - 30 * 86400000;
  await db
    .prepare("DELETE FROM alert_deliveries WHERE claim IN (SELECT claim FROM alert_deliveries WHERE created_at<? ORDER BY created_at,claim LIMIT 500)")
    .bind(cutoff)
    .run();
  const request = await db
    .prepare("SELECT 1 FROM approvals WHERE id=? AND created_at>=?")
    .bind(requestId, new Date(cutoff).toISOString())
    .first();
  if (!request) return;
  const subscriptions = await db
    .prepare("SELECT id FROM alert_subscriptions")
    .all<{ id: string }>();
  if (!subscriptions.results.length) return;
  const key = await keys(db),
    live = await db
      .prepare("SELECT data FROM live WHERE item_id='site'")
      .first<{ data: string }>();
  const title = live
    ? String(JSON.parse(live.data).title || "Porchsite")
    : "Porchsite";
  async function send(id: string) {
    try {
      const at = Date.now(),
        claim = crypto.randomUUID();
      const results = await db.batch([
        db
          .prepare(
            `INSERT OR IGNORE INTO alert_deliveries(request_id,subscription_id,claim,attempted,created_at)
          SELECT ?,s.id,?,CASE WHEN s.last_claim_at>0 AND ?-s.last_claim_at<300000 AND s.opened_at<=s.last_claim_at THEN 0 ELSE 1 END,?
          FROM alert_subscriptions s JOIN auth_state a ON a.id=1 AND a.owner_epoch=s.epoch JOIN passkeys p ON p.id=s.credential_id
          WHERE s.id=? AND EXISTS(SELECT 1 FROM approvals WHERE id=? AND status='pending')`,
          )
          .bind(requestId, claim, at, at, id, requestId),
        db
          .prepare(
            "UPDATE alert_subscriptions SET last_claim_at=MAX(?,opened_at) WHERE id=? AND EXISTS(SELECT 1 FROM alert_deliveries WHERE claim=? AND attempted=1)",
          )
          .bind(at, id, claim),
        db
          .prepare(
            "SELECT s.* FROM alert_subscriptions s JOIN alert_deliveries d ON d.subscription_id=s.id WHERE d.claim=? AND d.attempted=1",
          )
          .bind(claim),
      ]);
      const sub = results[2].results[0] as any;
      if (!sub) return;
      const url = wire.endpoint(sub.endpoint),
        body = await wire.encrypt(
          new TextEncoder().encode(JSON.stringify(payload(title, sub.origin))),
          sub.p256dh,
          sub.auth,
        );
      const authorization = await wire.authorization(
        key.private_key,
        key.public_key,
        url,
        sub.origin,
      );
      const response = await transport(url, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(3000),
        headers: {
          Authorization: authorization,
          "Content-Encoding": "aes128gcm",
          "Content-Type": "application/octet-stream",
          TTL: "300",
        },
        body,
      });
      await response.body?.cancel();
      if (response.status === 404 || response.status === 410)
        await db
          .prepare("DELETE FROM alert_subscriptions WHERE id=?")
          .bind(id)
          .run();
      else if (response.ok)
        await db
          .prepare("UPDATE alert_subscriptions SET last_used_at=? WHERE id=?")
          .bind(Date.now(), id)
          .run();
    } catch {
      /* Nudges are optional; never log subscription secrets or payloads. */
    }
  }
  for (let at = 0; at < subscriptions.results.length; at += 4)
    await Promise.all(
      subscriptions.results.slice(at, at + 4).map((s) => send(s.id)),
    );
}
const tasks = new Set<Promise<void>>();
export function schedule(db: D1Database, requestId: string) {
  const pending = sendApproval(db, requestId).catch(() => {});
  tasks.add(pending);
  void pending.finally(() => tasks.delete(pending));
  try {
    waitUntil(pending);
  } catch {
    /* No request lifetime: no delivery guarantee. */
  }
}
export async function drain() {
  await Promise.all([...tasks]);
}
