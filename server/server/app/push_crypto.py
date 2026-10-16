"""RFC 8291/8292 using the same primitives and wire format as the Worker."""

import base64
import hashlib
import hmac
import json
import re
import secrets
import time
from urllib.parse import urlsplit, urlunsplit

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def b64(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def unb64(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", value):
        raise ValueError("Invalid subscription key")
    data = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    if b64(data) != value:
        raise ValueError("Invalid subscription key")
    return data


def endpoint(value):
    if not isinstance(value, str) or len(value) > 2048 or re.search(r"[^\x21-\x7e]|\\", value):
        raise ValueError("Unsupported push service")
    authority = re.match(r"https://([^/?#]+)", value, re.I)
    if not authority or not re.fullmatch(r"[A-Za-z0-9.-]+(?::443)?", authority[1]) or "#" in value:
        raise ValueError("Unsupported push service")
    u = urlsplit(value)
    host = u.hostname or ""
    if (
        u.scheme != "https"
        or u.port not in (None, 443)
        or u.username
        or u.password
        or u.fragment
        or any(
            not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?", label) or label.startswith("xn--")
            for label in host.split(".")
        )
    ):
        raise ValueError("Unsupported push service")
    if host not in ("fcm.googleapis.com", "updates.push.services.mozilla.com") and not any(
        host.endswith(suffix) and len(host) > len(suffix)
        for suffix in (".push.apple.com", ".notify.windows.com")
    ):
        raise ValueError("Unsupported push service")
    return urlunsplit(("https", host, u.path or "/", u.query, ""))


def public_key(value):
    data = unb64(value)
    if len(data) != 65 or data[0] != 4:
        raise ValueError("Invalid subscription key")
    return ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), data)


def key_pair():
    key = ec.generate_private_key(ec.SECP256R1())
    pub = key.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    n = key.private_numbers()
    return {
        "private_key": json.dumps(
            {
                "kty": "EC",
                "crv": "P-256",
                "x": b64(pub[1:33]),
                "y": b64(pub[33:]),
                "d": b64(n.private_value.to_bytes(32, "big")),
            }
        ),
        "public_key": b64(pub),
    }


def _hmac(key, data):
    return hmac.new(key, data, hashlib.sha256).digest()


def encrypt(message, p256dh, auth, seed=None):
    ua, secret = public_key(p256dh), unb64(auth)
    if len(secret) != 16:
        raise ValueError("Invalid subscription key")
    private = (
        ec.derive_private_key(int.from_bytes(unb64(seed["privateKey"]["d"]), "big"), ec.SECP256R1())
        if seed
        else ec.generate_private_key(ec.SECP256R1())
    )
    pub = private.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    ikm = _hmac(
        _hmac(secret, private.exchange(ec.ECDH(), ua)),
        b"WebPush: info\0" + unb64(p256dh) + pub + b"\x01",
    )
    salt = seed["salt"] if seed else secrets.token_bytes(16)
    prk = _hmac(salt, ikm)
    key = _hmac(prk, b"Content-Encoding: aes128gcm\0\x01")[:16]
    nonce = _hmac(prk, b"Content-Encoding: nonce\0\x01")[:12]
    if len(message) > 3000:
        raise ValueError("Push payload too large")
    return salt + b"\0\0\x10\0\x41" + pub + AESGCM(key).encrypt(nonce, message + b"\x02", None)


def authorization(private_key, public_key, url, origin, now=None):
    def encode(value):
        return b64(json.dumps(value, separators=(",", ":")).encode())

    u = urlsplit(endpoint(url))
    data = (
        encode({"typ": "JWT", "alg": "ES256"})
        + "."
        + encode(
            {
                "aud": f"https://{u.hostname}",
                "exp": int(now if now is not None else time.time()) + 43200,
                "sub": origin,
            }
        )
    )
    jwk = json.loads(private_key)
    key = ec.derive_private_key(int.from_bytes(unb64(jwk["d"]), "big"), ec.SECP256R1())
    r, s = decode_dss_signature(key.sign(data.encode(), ec.ECDSA(hashes.SHA256())))
    return f"vapid t={data}.{b64(r.to_bytes(32, 'big') + s.to_bytes(32, 'big'))}, k={public_key}"
