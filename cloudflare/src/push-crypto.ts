/** RFC 8291 aes128gcm and RFC 8292 VAPID; platform primitives only. */
const utf8 = new TextEncoder();
export const b64 = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
export function unb64(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new Error("Invalid subscription key");
  const out = Uint8Array.from(
    atob(
      s.replace(/-/g, "+").replace(/_/g, "/") +
        "=".repeat((4 - (s.length % 4)) % 4),
    ),
    (c) => c.charCodeAt(0),
  );
  if (b64(out) !== s) throw new Error("Invalid subscription key");
  return out;
}
export function endpoint(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    /[^\x21-\x7e]|\\/.test(value)
  )
    throw new Error("Unsupported push service");
  const authority = /^https:\/\/([^/?#]+)/i.exec(value)?.[1];
  if (
    !authority ||
    !/^[A-Za-z0-9.-]+(?::443)?$/.test(authority) ||
    value.includes("#")
  )
    throw new Error("Unsupported push service");
  const u = new URL(value),
    host = u.hostname.toLowerCase();
  if (
    u.protocol !== "https:" ||
    (u.port && u.port !== "443") ||
    u.username ||
    u.password ||
    u.hash ||
    host.endsWith(".") ||
    host
      .split(".")
      .some(
        (x) =>
          !x ||
          x.startsWith("xn--") ||
          !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(x),
      )
  )
    throw new Error("Unsupported push service");
  if (
    !["fcm.googleapis.com", "updates.push.services.mozilla.com"].includes(
      host,
    ) &&
    ![".push.apple.com", ".notify.windows.com"].some(
      (s) => host.endsWith(s) && host.length > s.length,
    )
  )
    throw new Error("Unsupported push service");
  return u.href;
}
export const join = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
async function hmac(key: Uint8Array, data: Uint8Array) {
  const k = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}
export async function publicKey(value: string) {
  const bytes = unb64(value);
  if (bytes.length !== 65 || bytes[0] !== 4)
    throw new Error("Invalid subscription key");
  return crypto.subtle.importKey(
    "raw",
    bytes,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
}
export async function keyPair() {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  return {
    private_key: JSON.stringify(
      await crypto.subtle.exportKey("jwk", pair.privateKey),
    ),
    public_key: b64(
      new Uint8Array(
        (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
      ),
    ),
  };
}
export async function encrypt(
  message: Uint8Array,
  p256dh: string,
  auth: string,
  seed?: { privateKey: JsonWebKey; salt: Uint8Array },
) {
  const ua = await publicKey(p256dh),
    secret = unb64(auth);
  if (secret.length !== 16) throw new Error("Invalid subscription key");
  const pair = seed
    ? null
    : ((await crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        true,
        ["deriveBits"],
      )) as CryptoKeyPair);
  const privateKey = seed
    ? await crypto.subtle.importKey(
        "jwk",
        seed.privateKey,
        { name: "ECDH", namedCurve: "P-256" },
        true,
        ["deriveBits"],
      )
    : pair!.privateKey;
  const jwk = (await crypto.subtle.exportKey("jwk", privateKey)) as JsonWebKey;
  const pub = join(new Uint8Array([4]), unb64(jwk.x!), unb64(jwk.y!));
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", ["public"]: ua } as SubtleCryptoDeriveKeyAlgorithm,
      privateKey,
      256,
    ),
  );
  const ikm = await hmac(
    await hmac(secret, shared),
    join(
      utf8.encode("WebPush: info\0"),
      unb64(p256dh),
      pub,
      new Uint8Array([1]),
    ),
  );
  const salt = seed?.salt ?? crypto.getRandomValues(new Uint8Array(16)),
    prk = await hmac(salt, ikm);
  const key = (
    await hmac(prk, utf8.encode("Content-Encoding: aes128gcm\0\x01"))
  ).slice(0, 16);
  const nonce = (
    await hmac(prk, utf8.encode("Content-Encoding: nonce\0\x01"))
  ).slice(0, 12);
  if (message.length > 3000) throw new Error("Push payload too large");
  const aes = await crypto.subtle.importKey("raw", key, "AES-GCM", false, [
    "encrypt",
  ]);
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce },
      aes,
      join(message, new Uint8Array([2])),
    ),
  );
  return join(salt, new Uint8Array([0, 0, 16, 0, 65]), pub, encrypted);
}
export async function authorization(
  privateKey: string,
  publicKey: string,
  url: string,
  origin: string,
  now = Date.now(),
) {
  const encode = (v: unknown) => b64(utf8.encode(JSON.stringify(v)));
  const data =
    encode({ typ: "JWT", alg: "ES256" }) +
    "." +
    encode({
      aud: new URL(endpoint(url)).origin,
      exp: Math.floor(now / 1000) + 43200,
      sub: origin,
    });
  const key = await crypto.subtle.importKey(
    "jwk",
    JSON.parse(privateKey),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      utf8.encode(data),
    ),
  );
  return `vapid t=${data}.${b64(sig)}, k=${publicKey}`;
}
