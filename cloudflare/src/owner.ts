/**
 * The owner: one person, signed in with a passkey. A fresh site is claimed
 * once, with a setup code (the one given at deploy time, or a one-time code
 * stored hashed with an expiry); after that every setup code is dead and the
 * setup page is closed for good.
 */
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { ApiError } from "./errors";

export const SESSION_COOKIE = "__Host-sk_owner";
const CHALLENGE_COOKIE = "__Host-sk_challenge";
const SESSION_DAYS = 30;

const now = () => new Date();
const iso = (d: Date) => d.toISOString();

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hash(token: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return b64url(new Uint8Array(d));
}

function cookie(req: Request, name: string): string | null {
  const m = (req.headers.get("Cookie") ?? "").match(new RegExp(`(?:^|;\\s*)${name.replace(/[-]/g, "\\-")}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

function setCookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

/** Constant-time string compare, for the setup code. */
function same(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export function rp(req: Request): { rpID: string; origin: string } {
  const u = new URL(req.url);
  return { rpID: u.hostname, origin: u.origin };
}

export async function hasOwner(db: D1Database): Promise<boolean> {
  return !!(await db.prepare("SELECT 1 FROM owner WHERE id = 1").first());
}

export async function ownerName(db: D1Database): Promise<string> {
  const row = await db.prepare("SELECT name FROM owner WHERE id = 1").first<{ name: string }>();
  return row?.name ?? "";
}

async function saveChallenge(db: D1Database, challenge: string, purpose: string): Promise<string> {
  const id = b64url(crypto.getRandomValues(new Uint8Array(18)));
  await db.batch([
    db.prepare("DELETE FROM challenges WHERE expires_at < ?").bind(iso(now())),
    db
      .prepare("INSERT INTO challenges (id, challenge, purpose, expires_at) VALUES (?, ?, ?, ?)")
      .bind(id, challenge, purpose, iso(new Date(Date.now() + 5 * 60_000))),
  ]);
  return setCookie(CHALLENGE_COOKIE, id, 300);
}

async function takeChallenge(db: D1Database, req: Request, purpose: string): Promise<string> {
  const id = cookie(req, CHALLENGE_COOKIE);
  if (!id) throw new ApiError(400, "expired", "This sign-in expired. Start again.");
  const row = await db
    .prepare("DELETE FROM challenges WHERE id = ? AND purpose = ? AND expires_at > ? RETURNING challenge")
    .bind(id, purpose, iso(now()))
    .first<{ challenge: string }>();
  if (!row) throw new ApiError(400, "expired", "This sign-in expired. Start again.");
  return row.challenge;
}

// --- claiming a fresh site ----------------------------------------------------

export const SETUP_HOURS = 24;
const NO_SETUP_CODE = "This site has no setup code yet. Ask whoever set up your site for a setup link.";
const CODE_EXPIRED = "This setup link has expired. If the site was installed at get.porchsite.dev/install/, run it again with the same name and token for a new one; otherwise ask whoever set it up.";

/**
 * Store a one-time setup code (hashed) that works for `hours`; any earlier
 * stored code stops working. Returns when it expires. Refused once the site
 * is claimed.
 */
export async function issueSetupCode(db: D1Database, code: string, hours: number = SETUP_HOURS): Promise<string> {
  if (await hasOwner(db)) throw new ApiError(409, "claimed", "This site already has an owner.");
  const expiresAt = iso(new Date(Date.now() + hours * 3600_000));
  await db.batch([
    db.prepare("DELETE FROM setup_codes"),
    db.prepare("INSERT INTO setup_codes (code_hash, created_at, expires_at) VALUES (?, ?, ?)").bind(await hash(code), iso(now()), expiresAt),
  ]);
  return expiresAt;
}

/** Refuse if the code a claim started with has stopped working since. */
async function stillWorks(db: D1Database, setupCode: string | undefined, via: string): Promise<void> {
  if (via === "env") {
    if (!setupCode || setupCode.length < 8) throw new ApiError(503, "no_setup_code", NO_SETUP_CODE);
  } else if (!(await db.prepare("SELECT 1 FROM setup_codes WHERE code_hash = ? AND expires_at > ?").bind(via, iso(now())).first())) {
    throw new ApiError(403, "code_expired", CODE_EXPIRED);
  }
}

/**
 * Which setup code this is: "env" (the deploy-time one) or the hash of a
 * stored one. Refuses a wrong, replaced or expired code.
 */
async function checkSetupCode(db: D1Database, setupCode: string | undefined, given: string): Promise<string> {
  const code = given.trim();
  const envOk = !!setupCode && setupCode.length >= 8;
  if (envOk && same(code, setupCode!)) return "env";
  const h = await hash(code);
  const row = await db.prepare("SELECT expires_at FROM setup_codes WHERE code_hash = ?").bind(h).first<{ expires_at: string }>();
  if (row && row.expires_at > iso(now())) return h;
  if (row) throw new ApiError(403, "code_expired", CODE_EXPIRED);
  if (!envOk && !(await db.prepare("SELECT 1 FROM setup_codes WHERE expires_at > ?").bind(iso(now())).first())) {
    throw new ApiError(503, "no_setup_code", NO_SETUP_CODE);
  }
  throw new ApiError(403, "bad_code", "That setup code isn't right.");
}

// A response that doesn't check out is the owner's refusal, never a 500: the
// library throws on most failures (wrong origin, bad signature) rather than
// returning verified: false.
async function registration(opts: Parameters<typeof verifyRegistrationResponse>[0]) {
  let result: Awaited<ReturnType<typeof verifyRegistrationResponse>> | undefined;
  try {
    result = await verifyRegistrationResponse(opts);
  } catch {
    result = undefined;
  }
  if (!result?.verified) throw new ApiError(400, "not_verified", "The passkey couldn't be verified. Try again.");
  return result;
}

async function authentication(opts: Parameters<typeof verifyAuthenticationResponse>[0]) {
  let result: Awaited<ReturnType<typeof verifyAuthenticationResponse>> | undefined;
  try {
    result = await verifyAuthenticationResponse(opts);
  } catch {
    result = undefined;
  }
  if (!result?.verified) throw new ApiError(403, "not_verified", "The passkey couldn't be verified.");
  return result;
}

export async function setupOptions(db: D1Database, req: Request, setupCode: string | undefined, code: string, name: string) {
  if (await hasOwner(db)) throw new ApiError(409, "claimed", "This site already has an owner. Sign in instead.");
  const via = await checkSetupCode(db, setupCode, code);
  const { rpID } = rp(req);
  const userHandle = crypto.getRandomValues(new Uint8Array(16));
  const options = await generateRegistrationOptions({
    rpName: name || "My site",
    rpID,
    userName: name || "owner",
    userID: userHandle,
    attestationType: "none",
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  const setCookieHeader = await saveChallenge(db, JSON.stringify({ challenge: options.challenge, name, handle: b64url(userHandle), via }), "setup");
  return { options, setCookieHeader };
}

export async function setupVerify(db: D1Database, req: Request, setupCode: string | undefined, response: any) {
  const saved = JSON.parse(await takeChallenge(db, req, "setup"));
  if (await hasOwner(db)) throw new ApiError(409, "claimed", "This site already has an owner.");
  // The code must still work: a newer setup link, or an expiry, ends it.
  await stillWorks(db, setupCode, saved.via ?? "env");
  const { rpID, origin } = rp(req);
  const result = await registration({
    response,
    expectedChallenge: saved.challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
  });
  const cred = result.registrationInfo.credential;
  const at = iso(now());
  // INSERT into owner fails on a second claim (id is fixed at 1), so two
  // racing claims can't both win.
  await db.batch([
    db.prepare("INSERT INTO owner (id, name, user_handle, created_at) VALUES (1, ?, ?, ?)").bind(saved.name || "", saved.handle, at),
    db
      .prepare("INSERT INTO passkeys (id, public_key, counter, transports, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(cred.id, cred.publicKey, cred.counter, JSON.stringify(cred.transports ?? []), at),
    // Claimed: every setup code is done.
    db.prepare("DELETE FROM setup_codes"),
  ]);
  return startSession(db);
}

// --- another passkey: a new device, or the site at a new address -------------

const LINK_MINUTES = 15;

/** A one-time link to add a passkey; only a signed-in owner can make one. */
export async function createPasskeyLink(db: D1Database): Promise<{ token: string; expires_at: string }> {
  const token = b64url(crypto.getRandomValues(new Uint8Array(24)));
  const expires_at = iso(new Date(Date.now() + LINK_MINUTES * 60_000));
  await db
    .prepare("INSERT INTO passkey_links (token_hash, created_at, expires_at) VALUES (?, ?, ?)")
    .bind(await hash(token), iso(now()), expires_at)
    .run();
  return { token, expires_at };
}

export async function passkeyLinkOpen(db: D1Database, token: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 FROM passkey_links WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?")
    .bind(await hash(token), iso(now()))
    .first();
  return !!row;
}

export async function addOptions(db: D1Database, req: Request, token: string) {
  if (!(await passkeyLinkOpen(db, token))) throw new ApiError(410, "link_used", "This link has been used or has expired. Make a new one where you're signed in.");
  const o = await db.prepare("SELECT name, user_handle FROM owner WHERE id = 1").first<{ name: string; user_handle: string }>();
  if (!o) throw new ApiError(409, "unclaimed", "This site has no owner yet.");
  const { rpID } = rp(req);
  const handle = Uint8Array.from(atob(o.user_handle.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const { results } = await db.prepare("SELECT id FROM passkeys").all<{ id: string }>();
  const options = await generateRegistrationOptions({
    rpName: o.name || "My site",
    rpID,
    userName: o.name || "owner",
    userID: handle,
    attestationType: "none",
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    excludeCredentials: results.map((r) => ({ id: r.id })),
  });
  const setCookieHeader = await saveChallenge(db, JSON.stringify({ challenge: options.challenge, link: await hash(token) }), "add");
  return { options, setCookieHeader };
}

export async function addVerify(db: D1Database, req: Request, response: any) {
  const saved = JSON.parse(await takeChallenge(db, req, "add"));
  const { rpID, origin } = rp(req);
  const result = await registration({
    response,
    expectedChallenge: saved.challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
  });
  const cred = result.registrationInfo.credential;
  const at = iso(now());
  // Spend the link first: of two racing uses, only one gets a row back.
  const spent = await db
    .prepare("UPDATE passkey_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING token_hash")
    .bind(at, saved.link, at)
    .first();
  if (!spent) throw new ApiError(410, "link_used", "This link has been used or has expired. Make a new one where you're signed in.");
  await db
    .prepare("INSERT INTO passkeys (id, public_key, counter, transports, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(cred.id, cred.publicKey, cred.counter, JSON.stringify(cred.transports ?? []), at)
    .run();
  return startSession(db);
}

export async function passkeyCount(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM passkeys").first<{ n: number }>();
  return row?.n ?? 0;
}

// --- signing in -------------------------------------------------------------

export async function loginOptions(db: D1Database, req: Request) {
  const { rpID } = rp(req);
  const options = await generateAuthenticationOptions({ rpID, userVerification: "required" });
  return { options, setCookieHeader: await saveChallenge(db, options.challenge, "login") };
}

export async function loginVerify(db: D1Database, req: Request, response: any) {
  const challenge = await takeChallenge(db, req, "login");
  const row = await db
    .prepare("SELECT id, public_key, counter, transports FROM passkeys WHERE id = ?")
    .bind(String(response?.id ?? ""))
    .first<{ id: string; public_key: ArrayBuffer; counter: number; transports: string }>();
  if (!row) throw new ApiError(403, "unknown_passkey", "That passkey isn't this site's owner.");
  const { rpID, origin } = rp(req);
  const result = await authentication({
    response,
    expectedChallenge: challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
    credential: { id: row.id, publicKey: new Uint8Array(row.public_key), counter: row.counter, transports: JSON.parse(row.transports) },
  });

  await db
    .prepare("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?")
    .bind(result.authenticationInfo.newCounter, iso(now()), row.id)
    .run();
  return startSession(db);
}

async function startSession(db: D1Database): Promise<string> {
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  await db
    .prepare("INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)")
    .bind(await hash(token), iso(now()), iso(new Date(Date.now() + SESSION_DAYS * 86400_000)))
    .run();
  return setCookie(SESSION_COOKIE, token, SESSION_DAYS * 86400);
}

export async function signedIn(db: D1Database, req: Request): Promise<boolean> {
  const token = cookie(req, SESSION_COOKIE);
  if (!token) return false;
  const row = await db
    .prepare("SELECT 1 FROM sessions WHERE token_hash = ? AND expires_at > ?")
    .bind(await hash(token), iso(now()))
    .first();
  return !!row;
}

export async function signOut(db: D1Database, req: Request): Promise<string> {
  const token = cookie(req, SESSION_COOKIE);
  if (token) await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await hash(token)).run();
  return setCookie(SESSION_COOKIE, "", 0);
}

/** A per-session form token: forms posted from another site can't know it. */
export async function csrf(req: Request): Promise<string> {
  return (await hash(`csrf:${cookie(req, SESSION_COOKIE) ?? ""}`)).slice(0, 32);
}
