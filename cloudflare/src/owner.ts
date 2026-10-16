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
export const READER_COOKIE = "__Host-sk_reader";
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
  try { return m ? decodeURIComponent(m[1]) : null; } catch { return null; }
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
  return startSession(db, cred.id, 0);
}

// --- another passkey: a new device, or the site at a new address -------------

const LINK_MINUTES = 15;

/** HTTP callers pass req to fence issuance against recovery; internal callers already hold database authority. */
export async function createPasskeyLink(db: D1Database, req?: Request): Promise<{ token: string; expires_at: string }> {
  const token = b64url(crypto.getRandomValues(new Uint8Array(24)));
  const expires_at = iso(new Date(Date.now() + LINK_MINUTES * 60_000));
  const statement = db.prepare(`INSERT INTO passkey_links (token_hash, created_at, expires_at) SELECT ?, ?, ? WHERE ${req ? "EXISTS ("+OWNER_SESSION_QUERY+")" : "1"}`);
  const result = await statement.bind(await hash(token), iso(now()), expires_at, ...(req ? [await hash(cookie(req,SESSION_COOKIE) ?? ""),iso(now())] : [])).run();
  if (result.meta.changes !== 1) throw new ApiError(403,"not_verified","This sign-in stopped working. Start again.");

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
  const setCookieHeader = await saveChallenge(db, JSON.stringify({ challenge: options.challenge, link: await hash(token), epoch: await ownerEpoch(db) }), "add");
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
  return issueSession(db, "owner", cred.id, saved.epoch, {
    guard: "EXISTS (SELECT 1 FROM passkey_links WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?)",
    args: [saved.link, at],
    writes: (op) => [
      db.prepare("UPDATE passkey_links SET used_at = ? WHERE token_hash = ? AND EXISTS (SELECT 1 FROM auth_operations WHERE id = ?)").bind(at, saved.link, op),
      db.prepare("INSERT INTO passkeys (id, public_key, counter, transports, created_at) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM auth_operations WHERE id = ?)").bind(cred.id, cred.publicKey, cred.counter, JSON.stringify(cred.transports ?? []), at, op),
    ],
    newCredential: true,
  });
}

export async function passkeyCount(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM passkeys").first<{ n: number }>();
  return row?.n ?? 0;
}

// --- signing in -------------------------------------------------------------

export async function loginOptions(db: D1Database, req: Request) {
  const { rpID } = rp(req);
  const options = await generateAuthenticationOptions({ rpID, userVerification: "required" });
  return { options, setCookieHeader: await saveChallenge(db, JSON.stringify({challenge: options.challenge, epoch: await ownerEpoch(db)}), "login") };
}

export async function loginVerify(db: D1Database, req: Request, response: any) {
  const saved = JSON.parse(await takeChallenge(db, req, "login"));
  const id = String(response?.id ?? "");
  const ownerKey = await db.prepare("SELECT id, public_key, counter, transports FROM passkeys WHERE id = ?").bind(id).first<any>();
  // Always do both lookups, including for an unknown key.
  const readerKey = await db.prepare("SELECT p.*, r.auth_epoch, r.revoked FROM reader_passkeys p JOIN readers r ON r.id = p.reader_id WHERE p.id = ?").bind(id).first<any>();
  const row = ownerKey || (readerKey && !readerKey.revoked ? readerKey : null);
  if (!row) throw new ApiError(403, "unknown_passkey", "That passkey isn't registered for this site.");
  const expected = ownerKey ? saved.epoch : readerKey.auth_epoch;
  const { rpID, origin } = rp(req);
  const result = await authentication({ response, expectedChallenge: saved.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
    credential: {id: row.id, publicKey: new Uint8Array(row.public_key), counter: row.counter, transports: JSON.parse(row.transports)},
  });
  const role = ownerKey ? "owner" : "reader";
  return issueSession(db, role, row.id, expected, {
    readerId: readerKey?.reader_id,
    writes: op => [db.prepare(`UPDATE ${ownerKey ? "passkeys" : "reader_passkeys"} SET counter = ?, last_used_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM auth_operations WHERE id = ?)`)
      .bind(result.authenticationInfo.newCounter, iso(now()), row.id, op)],
  });
}

export async function ownerEpoch(db: D1Database): Promise<number> {
  return (await db.prepare("SELECT owner_epoch FROM auth_state WHERE id = 1").first<number>("owner_epoch")) ?? 0;
}

/** One D1 transaction: claim a conditional operation, write only under that claim. */
async function issueSession(db: D1Database, role: "owner" | "reader", credential: string, expected: number,
  extra: { readerId?: string; guard?: string; args?: any[]; newCredential?: boolean; writes?: (op: string) => D1PreparedStatement[] } = {}): Promise<string> {
  const token = b64url(crypto.getRandomValues(new Uint8Array(32))), th = await hash(token);
  const op = b64url(crypto.getRandomValues(new Uint8Array(24))), at = iso(now()), expires = iso(new Date(Date.now() + SESSION_DAYS * 86400_000));
  const condition = role === "owner"
    ? "EXISTS (SELECT 1 FROM auth_state WHERE id = 1 AND owner_epoch = ?) AND EXISTS (SELECT 1 FROM owner WHERE id = 1)" + (extra.newCredential ? "" : " AND EXISTS (SELECT 1 FROM passkeys WHERE id = ?)")
    : "EXISTS (SELECT 1 FROM readers WHERE id = ? AND auth_epoch = ? AND revoked = 0)" + (extra.newCredential ? "" : " AND EXISTS (SELECT 1 FROM reader_passkeys WHERE id = ? AND reader_id = ?)");
  const args = role === "owner" ? [expected, ...(extra.newCredential ? [] : [credential])] : [extra.readerId, expected, ...(extra.newCredential ? [] : [credential, extra.readerId])];
  const stmts = [db.prepare(`INSERT INTO auth_operations (id) SELECT ? WHERE ${condition}${extra.guard ? " AND (" + extra.guard + ")" : ""}`).bind(op, ...args, ...(extra.args ?? [])), ...(extra.writes?.(op) ?? [])];
  if (role === "owner") stmts.push(
    db.prepare("INSERT INTO sessions (token_hash, created_at, expires_at) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM auth_operations WHERE id = ?)").bind(th, at, expires, op),
    db.prepare("INSERT INTO owner_session_auth (token_hash, credential_id, epoch) SELECT ?, ?, owner_epoch FROM auth_state WHERE id = 1 AND EXISTS (SELECT 1 FROM auth_operations WHERE id = ?)").bind(th, credential, op),
  );
  else stmts.push(db.prepare("INSERT INTO reader_sessions (token_hash, reader_id, credential_id, epoch, created_at, expires_at) SELECT ?, ?, ?, auth_epoch, ?, ? FROM readers WHERE id = ? AND EXISTS (SELECT 1 FROM auth_operations WHERE id = ?)").bind(th, extra.readerId, credential, at, expires, extra.readerId, op));
  stmts.push(db.prepare("DELETE FROM auth_operations WHERE id = ?").bind(op));
  const results = await db.batch(stmts);
  // The first write under a new-credential claim consumes its link or code.
  // D1 executes the guard, consumption and issuance in one serialized batch.
  if (results[0].meta.changes !== 1 || (extra.newCredential && results[1].meta.changes !== 1)) throw new ApiError(403, "not_verified", "This sign-in stopped working. Start again.");
  return setCookie(role === "owner" ? SESSION_COOKIE : READER_COOKIE, token, SESSION_DAYS * 86400);
}

async function startSession(db: D1Database, credential: string, expected: number): Promise<string> {
  return issueSession(db, "owner", credential, expected);
}

const OWNER_SESSION_QUERY = `SELECT 1 FROM sessions s JOIN auth_state a ON a.id = 1
    LEFT JOIN owner_session_auth m ON m.token_hash = s.token_hash
    WHERE s.token_hash = ? AND s.expires_at > ? AND
    ((m.token_hash IS NULL AND a.owner_epoch = 0) OR
     (m.epoch = a.owner_epoch AND EXISTS (SELECT 1 FROM passkeys WHERE id = m.credential_id)))`;

export async function signedIn(db: D1Database, req: Request): Promise<boolean> {
  const token = cookie(req, SESSION_COOKIE);
  if (!token) return false;
  return !!await db.prepare(OWNER_SESSION_QUERY).bind(await hash(token), iso(now())).first();
}

export async function readerSignedIn(db: D1Database, req: Request): Promise<boolean> {
  const token = cookie(req, READER_COOKIE);
  if (!token) return false;
  return !!await db.prepare(`SELECT 1 FROM reader_sessions s JOIN readers r ON r.id = s.reader_id
    JOIN reader_passkeys p ON p.id = s.credential_id AND p.reader_id = r.id
    WHERE s.token_hash = ? AND s.expires_at > ? AND r.revoked = 0 AND r.auth_epoch = s.epoch`).bind(await hash(token), iso(now())).first();
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


// --- reader invitations -----------------------------------------------------
export async function createReaderInvite(db: D1Database, name: string, req?: Request) {
  const token = b64url(crypto.getRandomValues(new Uint8Array(24))), id = b64url(crypto.getRandomValues(new Uint8Array(18)));
  const op = b64url(crypto.getRandomValues(new Uint8Array(24))), at = iso(now()), expires_at = iso(new Date(Date.now() + 7 * 86400_000));
  const result = await db.batch([
    db.prepare(`INSERT INTO auth_operations (id) SELECT ? WHERE ${req ? "EXISTS ("+OWNER_SESSION_QUERY+")" : "1"}`).bind(op,...(req ? [await hash(cookie(req,SESSION_COOKIE) ?? ""),at] : [])),
    db.prepare("INSERT INTO readers (id,name,created_at) SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM auth_operations WHERE id = ?)").bind(id,name.slice(0,80),at,op),
    db.prepare("INSERT INTO reader_invites (token_hash,reader_id,created_at,expires_at) SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM auth_operations WHERE id = ?)").bind(await hash(token),id,at,expires_at,op),
    db.prepare("DELETE FROM auth_operations WHERE id = ?").bind(op),
  ]);
  if (result[0].meta.changes !== 1) throw new ApiError(403,"not_verified","This sign-in stopped working. Start again.");
  return {token,id,expires_at};
}

export async function listReaders(db: D1Database) {
  return (await db.prepare("SELECT r.id, r.name, r.revoked, r.created_at, i.expires_at, i.used_at, (SELECT MAX(p.last_used_at) FROM reader_passkeys p WHERE p.reader_id = r.id) AS last_signed_in FROM readers r LEFT JOIN reader_invites i ON i.reader_id = r.id ORDER BY r.created_at").all()).results;
}
export async function revokeReader(db: D1Database, id: string) {
  await db.batch([
    db.prepare("UPDATE readers SET revoked = 1, auth_epoch = auth_epoch + 1 WHERE id = ?").bind(id),
    db.prepare("DELETE FROM reader_sessions WHERE reader_id = ?").bind(id),
    db.prepare("DELETE FROM reader_invites WHERE reader_id = ?").bind(id),
  ]);
}
export async function revokeInvite(db: D1Database, id: string) {
  await db.prepare("DELETE FROM reader_invites WHERE reader_id = ? AND used_at IS NULL").bind(id).run();
}
export async function inviteOptions(db: D1Database, req: Request, token: string) {
  const row = await db.prepare("SELECT i.token_hash, r.* FROM reader_invites i JOIN readers r ON r.id = i.reader_id WHERE i.token_hash = ? AND i.used_at IS NULL AND i.expires_at > ? AND r.revoked = 0").bind(await hash(token), iso(now())).first<any>();
  if (!row) throw new ApiError(410, "link_used", "This invitation has been used or has expired.");
  const options = await generateRegistrationOptions({rpName: "Reader", rpID: rp(req).rpID, userName: row.name || "reader", attestationType: "none", authenticatorSelection: {residentKey:"required",userVerification:"required"}});
  return {options, setCookieHeader: await saveChallenge(db, JSON.stringify({challenge:options.challenge, invite:row.token_hash, reader:row.id, epoch:row.auth_epoch}), "invite")};
}
export async function inviteVerify(db: D1Database, req: Request, response: any) {
  const saved = JSON.parse(await takeChallenge(db, req, "invite"));
  const result = await registration({response, expectedChallenge:saved.challenge, expectedOrigin:rp(req).origin, expectedRPID:rp(req).rpID, requireUserVerification:true});
  const c = result.registrationInfo.credential, at = iso(now());
  return issueSession(db, "reader", c.id, saved.epoch, {readerId:saved.reader, newCredential:true,
    guard:"EXISTS (SELECT 1 FROM reader_invites WHERE token_hash = ? AND reader_id = ? AND used_at IS NULL AND expires_at > ?)", args:[saved.invite,saved.reader,at],
    writes:op=>[
      db.prepare("UPDATE reader_invites SET used_at = ? WHERE token_hash = ? AND EXISTS (SELECT 1 FROM auth_operations WHERE id = ?)").bind(at,saved.invite,op),
      db.prepare("INSERT INTO reader_passkeys (id,reader_id,public_key,counter,transports,created_at,last_used_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM auth_operations WHERE id = ?)").bind(c.id,saved.reader,c.publicKey,c.counter,JSON.stringify(c.transports ?? []),at,at,op),
    ]});
}

// --- recovery, issued only by the hosting account ---------------------------
export async function issueRecoveryCode(db: D1Database, code: string, hours = 24) {
  if (!(await hasOwner(db))) throw new ApiError(409,"unclaimed","This site has no owner yet.");
  if (code.length < 32) throw new ApiError(400,"bad_code","Use a fresh recovery code with at least 24 random bytes.");
  const expires = iso(new Date(Date.now()+hours*3600_000));
  await db.batch([db.prepare("DELETE FROM recovery_codes"), db.prepare("INSERT INTO recovery_codes (code_hash,created_at,expires_at) VALUES (?,?,?)").bind(await hash(code),iso(now()),expires)]);
  return expires;
}
async function recoveryCode(db: D1Database, code: string) {
  if (!(await hasOwner(db))) throw new ApiError(409,"unclaimed","This site has no owner yet.");
  const h = await hash(code.trim());
  const row = await db.prepare("SELECT expires_at FROM recovery_codes WHERE code_hash = ?").bind(h).first<any>();
  if (!row) throw new ApiError(403,"bad_code","That recovery code isn't valid or has expired.");
  if (row.expires_at <= iso(now())) throw new ApiError(403,"code_expired","That recovery code isn't valid or has expired.");
  return h;
}
export async function recoverOptions(db: D1Database, req: Request, code: string) {
  const h = await recoveryCode(db, code), epoch = await ownerEpoch(db);
  const o = await db.prepare("SELECT name,user_handle FROM owner WHERE id = 1").first<any>();
  const handle = Uint8Array.from(atob(o.user_handle.replace(/-/g,"+").replace(/_/g,"/")),c=>c.charCodeAt(0));
  const options = await generateRegistrationOptions({rpName:o.name||"My site",rpID:rp(req).rpID,userName:o.name||"owner",userID:handle,attestationType:"none",authenticatorSelection:{residentKey:"required",userVerification:"required"}});
  return {options,setCookieHeader:await saveChallenge(db,JSON.stringify({challenge:options.challenge,code:h,epoch}),"recover")};
}
export async function recoverVerify(db: D1Database, req: Request, response: any) {
  const saved = JSON.parse(await takeChallenge(db,req,"recover"));
  const result = await registration({response,expectedChallenge:saved.challenge,expectedOrigin:rp(req).origin,expectedRPID:rp(req).rpID,requireUserVerification:true});
  const c = result.registrationInfo.credential, at=iso(now());
  return issueSession(db,"owner",c.id,saved.epoch,{newCredential:true,
    guard:"EXISTS (SELECT 1 FROM recovery_codes WHERE code_hash = ? AND expires_at > ?)",args:[saved.code,at],
    writes:op=>[
      db.prepare("DELETE FROM recovery_codes WHERE code_hash = ? AND EXISTS (SELECT 1 FROM auth_operations WHERE id = ?)").bind(saved.code,op),
      db.prepare("DELETE FROM reader_invites WHERE used_at IS NULL AND EXISTS (SELECT 1 FROM auth_operations WHERE id = ?)").bind(op),
      db.prepare("UPDATE auth_state SET owner_epoch = owner_epoch + 1 WHERE id = 1 AND EXISTS (SELECT 1 FROM auth_operations WHERE id = ?)").bind(op),
      ...["alert_subscriptions","passkeys","passkey_links","sessions","owner_session_auth","reader_sessions"].map(t=>db.prepare(`DELETE FROM ${t} WHERE EXISTS (SELECT 1 FROM auth_operations WHERE id = ?)`).bind(op)),
      db.prepare("UPDATE readers SET auth_epoch = auth_epoch + 1 WHERE EXISTS (SELECT 1 FROM auth_operations WHERE id = ?)").bind(op),
      db.prepare("INSERT INTO passkeys (id,public_key,counter,transports,created_at) SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM auth_operations WHERE id = ?)").bind(c.id,c.publicKey,c.counter,JSON.stringify(c.transports??[]),at,op),
    ]});
}

/** Shared cleanup for owner credential removal; session validation checks existence. */
export async function removePasskey(db:D1Database,id:string) {
 await db.batch([db.prepare("DELETE FROM alert_subscriptions WHERE credential_id=?").bind(id),db.prepare("DELETE FROM passkeys WHERE id=?").bind(id)]);
}
