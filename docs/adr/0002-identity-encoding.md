# ADR 0002 — Identifiers, encodings and signature layout

- Status: accepted
- Date: 2026-10-12

HANDOFF §4 defines the shape of these values but leaves the exact byte formats open. Decisions, all implemented in `packages/crypto`:

## Encodings

- **base32** means RFC 4648, **lowercase, no padding**. It's used wherever the spec says "base32": `device_id`, `user_id` and fingerprints.
- **Binary values in JSON** (public keys, signatures, nonces) are **base64url without padding**. Ed25519 keys are 43 characters and signatures are 86.
- **File content hashes** are lowercase hex BLAKE3, 64 characters. The exact Merkle construction over chunk hashes is decided in M4.

## Identifiers

- `device_id = "d_" + base32(BLAKE3(device_pubkey)[0..16])`, following the spec.
- `user_id = "u_" + base32(BLAKE3(root_pubkey)[0..16])`. The spec doesn't define `user_id`. Deriving it from the root key means anyone can check that a root key belongs to a user id without asking the hub.
- `fingerprint = base32(BLAKE3(root_pubkey))` (52 characters), displayed in groups of 4.
- Group, session and message ids are ULIDs with prefixes `g_`, `x_` and `m_`.

## Signatures

Every signature covers `u32be(len(domain)) ‖ domain ‖ message`. The domains are:

- `communal/auth/v1`
- `communal/device-cert/v1`
- `communal/revocation/v1`
- `communal/restore/v1`
- `communal/transfer-token/v1`

This stops a signature made for one purpose from being replayed as another, for example a cert signature presented as an auth response.

Messages concatenate fields using `u32be` length prefixes for variable-length fields and `u64be` for timestamps. This is a strict superset of the spec's `user_id ‖ new_device_pubkey ‖ issued_at`, with domain separation and unambiguous boundaries added.

## Cert chains

- A chain is ordered from the root toward the device. `chain[0]` is signed by the root key, and each later cert is signed by the previous cert's subject. The root device has an empty chain.
- A device revoked anywhere in the chain invalidates every cert below it, because its signatures can no longer be trusted. A revoked device therefore also cannot revoke other devices.
- Chains are capped at 16 certs.

## Transfer tokens

Signed by the hub key over the canonical JSON array `[session_id, from, to, hash, exp]`.
