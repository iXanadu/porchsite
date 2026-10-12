// A software passkey for tests: a P-256 key that answers a site's WebAuthn
// options as a browser and an authenticator would (attestation "none", user
// present and verified). Port-matched: server/tests/app/softkey.py.

const enc = new TextEncoder();
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
};
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", b));

// Just enough CBOR: small maps, integers, byte and text strings.
function head(major: number, n: number): Uint8Array {
  if (n < 24) return Uint8Array.of((major << 5) | n);
  if (n < 256) return Uint8Array.of((major << 5) | 24, n);
  return Uint8Array.of((major << 5) | 25, n >> 8, n & 255);
}
type Cbor = number | string | Uint8Array | Map<Cbor, Cbor>;
function cbor(v: Cbor): Uint8Array {
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") {
    const b = enc.encode(v);
    return cat(head(3, b.length), b);
  }
  if (v instanceof Uint8Array) return cat(head(2, v.length), v);
  return cat(head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)]));
}

/** ECDSA's raw r||s as the DER signature WebAuthn carries. */
function der(raw: Uint8Array): Uint8Array {
  const int = (x: Uint8Array) => {
    let i = 0;
    while (i < x.length - 1 && x[i] === 0) i++;
    x = x.slice(i);
    if (x[0] & 0x80) x = cat(Uint8Array.of(0), x);
    return cat(Uint8Array.of(2, x.length), x);
  };
  const body = cat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return cat(Uint8Array.of(0x30, body.length), body);
}

export class SoftKey {
  id = crypto.getRandomValues(new Uint8Array(16));
  counter = 0;
  handle = "";
  private constructor(private key: CryptoKeyPair) {}

  static async make(): Promise<SoftKey> {
    return new SoftKey((await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair);
  }

  private clientData(type: string, challenge: string, origin: string) {
    return enc.encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  /** navigator.credentials.create(), as the JSON a page posts back. */
  async create(options: any, origin: string) {
    const jwk = (await crypto.subtle.exportKey("jwk", this.key.publicKey)) as JsonWebKey;
    const cose = cbor(new Map<Cbor, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, fromB64url(jwk.x!)], [-3, fromB64url(jwk.y!)]]));
    this.handle = options.user.id;
    const authData = cat(
      await sha256(enc.encode(options.rp.id)),
      Uint8Array.of(0x45), // user present, user verified, credential data
      Uint8Array.of(0, 0, 0, 0),
      new Uint8Array(16), // AAGUID
      Uint8Array.of(0, this.id.length),
      this.id,
      cose,
    );
    const attestationObject = cbor(new Map<Cbor, Cbor>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
    return {
      id: b64url(this.id),
      rawId: b64url(this.id),
      type: "public-key",
      response: {
        clientDataJSON: b64url(this.clientData("webauthn.create", options.challenge, origin)),
        attestationObject: b64url(attestationObject),
        transports: ["internal"],
      },
      clientExtensionResults: {},
    };
  }

  /** navigator.credentials.get(), as the JSON a page posts back. */
  async get(options: any, origin: string) {
    this.counter += 1;
    const c = this.counter;
    const authData = cat(await sha256(enc.encode(options.rpId)), Uint8Array.of(0x05), Uint8Array.of(c >>> 24, (c >>> 16) & 255, (c >>> 8) & 255, c & 255));
    const clientDataJSON = this.clientData("webauthn.get", options.challenge, origin);
    const raw = new Uint8Array(
      await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.key.privateKey, cat(authData, await sha256(clientDataJSON))),
    );
    return {
      id: b64url(this.id),
      rawId: b64url(this.id),
      type: "public-key",
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(der(raw)),
        userHandle: this.handle,
      },
      clientExtensionResults: {},
    };
  }
}
