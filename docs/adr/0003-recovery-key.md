# ADR 0003 — Recovery key formats

- Status: accepted
- Date: 2026-10-12

HANDOFF §4 calls for exporting the root private key either as a passphrase-encrypted file or as a word list.

## File

```json
{
  "format": "communal-recovery",
  "v": 1,
  "user_id": "u_…",
  "kdf": { "alg": "argon2id", "salt": "<b64url 16B>", "t": 3, "m": 65536, "p": 1 },
  "cipher": "xchacha20poly1305",
  "nonce": "<b64url 24B>",
  "ct": "<b64url>"
}
```

- **Key derivation:** Argon2id with t=3, m=64 MiB, p=1 (the OWASP minimum). The passphrase is NFKC-normalized first. The parameters are stored in the file so they can be raised later.
- **Encryption:** XChaCha20-Poly1305. The associated data binds the `user_id` and the KDF parameters, so editing either one makes decryption fail.
- **Libraries:** `@noble/hashes` (Argon2id) and `@noble/ciphers`, both audited pure JS with no native builds.
- **Speed:** Argon2id at 64 MiB in pure JS takes a few seconds. That's acceptable because export and restore are rare. Tests use small parameters.

## Word list

- **BIP39 English, 24 words.** The words encode the 32-byte Ed25519 seed directly, plus BIP39's built-in 8-bit checksum.
- This is a plain encoding of the seed and does **not** use the BIP39 seed derivation. Like the file, it is the raw root secret, so it must be protected the same way.
- Input is normalized: case is ignored and extra whitespace is accepted.
- The checksum catches most typos and word swaps.

## Restore

A fresh device signs a device cert for itself with the recovered root key (`account.restore`, with `root_sig`). Peers verify it like any other cert chain of length 1.
