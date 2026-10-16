/** Independent receiver for RFC vectors and cross-edition interoperability. */
import { unb64, join } from "../src/push-crypto";
export async function decrypt(
  body: Uint8Array,
  receiver: JsonWebKey,
  auth: string,
) {
  const salt = body.slice(0, 16),
    pub = body.slice(21, 21 + body[20]),
    cipher = body.slice(21 + body[20]);
  const ua = join(new Uint8Array([4]), unb64(receiver.x!), unb64(receiver.y!));
  const priv = await crypto.subtle.importKey(
    "jwk",
    receiver,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const sender = await crypto.subtle.importKey(
    "raw",
    pub,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = await crypto.subtle.deriveBits(
    { name: "ECDH", ["public"]: sender } as SubtleCryptoDeriveKeyAlgorithm,
    priv,
    256,
  );
  async function hkdf(
    key: Uint8Array,
    s: Uint8Array,
    info: Uint8Array,
    bits: number,
  ) {
    const material = await crypto.subtle.importKey("raw", key, "HKDF", false, [
      "deriveBits",
    ]);
    return new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt: s, info },
        material,
        bits,
      ),
    );
  }
  const enc = new TextEncoder(),
    ikm = await hkdf(
      new Uint8Array(shared),
      unb64(auth),
      join(enc.encode("WebPush: info\0"), ua, pub),
      256,
    );
  const cek = await hkdf(
      ikm,
      salt,
      enc.encode("Content-Encoding: aes128gcm\0"),
      128,
    ),
    nonce = await hkdf(ikm, salt, enc.encode("Content-Encoding: nonce\0"), 96);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, [
    "decrypt",
  ]);
  const out = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, cipher),
  );
  if (out[out.length - 1] !== 2) throw Error("Invalid final record");
  return new TextDecoder().decode(out.slice(0, -1));
}
