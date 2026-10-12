"""A software passkey for tests: a P-256 key that answers a site's WebAuthn
options as a browser and an authenticator would (attestation "none", user
present and verified). Port of cloudflare/test/softkey.ts."""

import base64
import hashlib
import json
import os
from typing import Any

import cbor2
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec


def b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


class SoftKey:
    def __init__(self) -> None:
        self.key = ec.generate_private_key(ec.SECP256R1())
        self.id = os.urandom(16)
        self.counter = 0
        self.handle = ""

    @staticmethod
    def _client_data(type_: str, challenge: str, origin: str) -> bytes:
        return json.dumps(
            {"type": type_, "challenge": challenge, "origin": origin, "crossOrigin": False},
            separators=(",", ":"),
        ).encode()

    def create(self, options: dict[str, Any], origin: str) -> dict[str, Any]:
        """navigator.credentials.create(), as the JSON a page posts back."""
        nums = self.key.public_key().public_numbers()
        cose = cbor2.dumps(
            {1: 2, 3: -7, -1: 1, -2: nums.x.to_bytes(32, "big"), -3: nums.y.to_bytes(32, "big")}
        )
        self.handle = options["user"]["id"]
        auth_data = (
            hashlib.sha256(options["rp"]["id"].encode()).digest()
            + bytes([0x45])  # user present, user verified, credential data
            + (0).to_bytes(4, "big")
            + bytes(16)  # AAGUID
            + len(self.id).to_bytes(2, "big")
            + self.id
            + cose
        )
        attestation = cbor2.dumps({"fmt": "none", "attStmt": {}, "authData": auth_data})
        return {
            "id": b64url(self.id),
            "rawId": b64url(self.id),
            "type": "public-key",
            "response": {
                "clientDataJSON": b64url(
                    self._client_data("webauthn.create", options["challenge"], origin)
                ),
                "attestationObject": b64url(attestation),
                "transports": ["internal"],
            },
            "clientExtensionResults": {},
        }

    def get(self, options: dict[str, Any], origin: str) -> dict[str, Any]:
        """navigator.credentials.get(), as the JSON a page posts back."""
        self.counter += 1
        auth_data = (
            hashlib.sha256(options["rpId"].encode()).digest()
            + bytes([0x05])
            + self.counter.to_bytes(4, "big")
        )
        client_data = self._client_data("webauthn.get", options["challenge"], origin)
        sig = self.key.sign(
            auth_data + hashlib.sha256(client_data).digest(), ec.ECDSA(hashes.SHA256())
        )
        return {
            "id": b64url(self.id),
            "rawId": b64url(self.id),
            "type": "public-key",
            "response": {
                "clientDataJSON": b64url(client_data),
                "authenticatorData": b64url(auth_data),
                "signature": b64url(sig),
                "userHandle": self.handle,
            },
            "clientExtensionResults": {},
        }
