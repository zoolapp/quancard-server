#!/usr/bin/env python3
"""Independent check (Python + cryptography, no QuanCard code) that a revision written by the web
client is exactly what the iOS strict reader accepts: envelope v1 AAD binding, sync v1 revision keys,
payload schema 2 key whitelists (as in iOS QVaultPayloadSchema), canonical UUIDs/dates and the
artwork digest. Usage: python3 tools/verify_web_vector.py vectors/web/revision-v1.json"""
import base64
import hashlib
import json
import re
import sys

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

UPPER = re.compile(r"^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$")
LOWER = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
FORBIDDEN = {"verificationcode", "cvv", "cid", "pin", "pinblock", "trackdata"}


def strict(text):
    def hook(pairs):
        keys = [k for k, _ in pairs]
        assert len(keys) == len(set(keys)), "duplicate key"
        for k in keys:
            assert k.lower() not in FORBIDDEN, f"forbidden key {k}"
        return dict(pairs)

    return json.loads(text, object_pairs_hook=hook, parse_float=lambda _: (_ for _ in ()).throw(AssertionError("fraction")))


def b64(value, size=None):
    raw = base64.b64decode(value, validate=True)
    assert base64.b64encode(raw).decode() == value, "non-canonical base64"
    assert size is None or len(raw) == size
    return raw


def b64url(value):
    raw = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    assert base64.urlsafe_b64encode(raw).decode().rstrip("=") == value
    return raw


def open_envelope(text, key, record, kind):
    env = strict(text)
    assert set(env) == {"formatVersion", "recordID", "objectKind", "wrappedDEK", "payload"}
    assert env["formatVersion"] == 1 and env["recordID"] == record and env["objectKind"] == kind
    wrapped = b64(env["wrappedDEK"], 60)
    aad = lambda stage: f"quancard.envelope.v1|{stage}|{kind}|{record}".encode()
    dek = AESGCM(key).decrypt(wrapped[:12], wrapped[12:], aad("dek"))
    payload = b64(env["payload"])
    return AESGCM(dek).decrypt(payload[:12], payload[12:], aad("payload"))


def exact(obj, keys):
    assert set(obj) == set(keys), f"keys {sorted(set(obj) ^ set(keys))}"


def main(path):
    v = json.load(open(path))
    key = base64.b64decode(v["syncKeyBase64"])
    vault = v["vaultID"]
    manifest = strict(open_envelope(v["manifestEnvelopeUTF8"], key, vault, "syncManifest.v1"))
    assert manifest == {"version": 1, "vaultID": vault}

    rev_text = v["revision"]["envelopeUTF8"]
    assert base64.b64encode(hashlib.sha256(rev_text.encode()).digest()).decode() == v["revision"]["sha256"]
    rid = strict(rev_text)["recordID"]
    rev = strict(open_envelope(rev_text, key, rid, "syncRevision.v1"))
    exact(rev, ["version", "vaultID", "revisionID", "itemID", "installationID", "counter", "parents", "snapshot"])
    assert rev["version"] == 1 and rev["vaultID"] == vault and rev["revisionID"] == rid
    for f in ["vaultID", "revisionID", "installationID"]:
        assert UPPER.match(rev[f]), f
    assert re.match(r"^[0-9A-F-]{36}$", rev["itemID"]) and isinstance(rev["counter"], int) and rev["counter"] > 0
    snap = b64(rev["snapshot"])
    assert snap.decode() == v["revision"]["snapshotUTF8"]

    p = strict(snap.decode())
    exact(p, ["payloadSchemaVersion", "createdAt", "items", "artworks"])
    assert p["payloadSchemaVersion"] == 2 and DATE.match(p["createdAt"])
    assert len(p["items"]) == 1 and len(p["artworks"]) <= 1
    item = p["items"][0]
    exact(item, ["itemSchemaVersion", "id", "displayName", "institutionName", "country", "tags", "notes", "artworkTemplateID",
                 "artworkBlobID", "lifecycle", "isFavorite", "manualSortPosition", "createdAt", "updatedAt", "kind", "paymentCard", "bankAccount"])
    assert item["id"].upper() == rev["itemID"] and LOWER.match(item["id"])
    assert DATE.match(item["createdAt"]) and DATE.match(item["updatedAt"])
    assert item["kind"] == "paymentCard" and item["bankAccount"] is None
    card = item["paymentCard"]
    exact(card, ["cardholderName", "pan", "expiryMonth", "expiryYear", "cvc", "network", "fundingType", "formFactor", "walletProvisions"])
    assert re.match(r"^[0-9]{3,4}$", card["cvc"])
    art = p["artworks"][0]
    exact(art, ["id", "mediaType", "sha256", "data"])
    assert art["mediaType"] == "image/jpeg" and art["id"] == item["artworkBlobID"] and LOWER.match(art["id"])
    data = b64url(art["data"])
    assert data[:3] == b"\xff\xd8\xff" and data[-2:] == b"\xff\xd9"
    assert hashlib.sha256(data).digest() == b64url(art["sha256"])

    # Negative checks: tampering and wrong binding must fail.
    env = strict(rev_text)
    raw = bytearray(b64(env["payload"]))
    raw[-1] ^= 1
    env["payload"] = base64.b64encode(bytes(raw)).decode()
    for args in [(json.dumps(env), key, rid, "syncRevision.v1"), (rev_text, bytes(32), rid, "syncRevision.v1"), (rev_text, key, rid, "vaultItem")]:
        try:
            open_envelope(*args)
        except Exception:
            continue
        raise AssertionError("tampered or mis-bound envelope accepted")
    print("PASS: web-produced manifest + revision open with an independent implementation and match the iOS strict schema; 3 negative cases")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "vectors/web/revision-v1.json")
