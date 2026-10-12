# ADR 0004 — Protocol catalog: additions and clarifications

- Status: accepted (M0); revisit as milestones land
- Date: 2026-10-12

`packages/protocol` has a zod schema for every message in HANDOFF §5 and every frame in §7. There is one schema map per direction (`clientBodies`, `hubBodies`), because some types carry different bodies each way. For example, `connection.request` goes c→h as `{user_id}` and h→c as `{user: UserSummary}`. This ADR lists where the schemas go beyond or pin down the HANDOFF catalog.

## Added message types

### Hub

| Type                                                | Why                                                                                                                           |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `ok` (h→c)                                          | Generic reply for commands that return no data (`acl.set`, `group.delete`, `watch`, …).                                       |
| `user.results`                                      | Reply to `user.search`. The catalog marks it c→h→c but doesn't name the reply.                                                |
| `connection.listing`, `group.listing`               | Replies to `connection.list` and `group.list`.                                                                                |
| `device.list` / `device.listing` / `device.revoked` | The Settings → Devices screen (§11) and revocation distribution (§4) need them.                                               |
| `link.denied`                                       | Tells the new device its claim was denied.                                                                                    |
| `acl.replace` (c→h, M3)                             | Full per-hub rule set for the device, sent on sign-in; keeps the hub in step with the client's authoritative copy (ADR 0009). |

### Peer

| Type              | Why                                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------- |
| `hello.ok`        | Lets the downloader know the uploader accepted `hello`.                                      |
| `peek.data`       | Reply to `peek`.                                                                             |
| `denied {reason}` | Uploader refusal with a machine-readable reason (bad token, revoked, `lan_only`, …).         |
| `peek.none` (M6)  | Nothing to peek at: not text, gone, or not allowed. Indistinguishable on purpose (ADR 0012). |

## Changed or clarified bodies

- **Proof of possession.** `account.create`, `link.claim` and `account.restore` include `sig` over the session challenge (`nonce ‖ hub_id`). These happen before `auth`, so without it a client could register a public key it doesn't hold.
- **`challenge`** includes `hub_pubkey` so the client can pin it on first contact (§4).
- **`welcome`** includes the client's own `user_id` and `device_id`.
- **`account.restore`** carries `root_pubkey`, `issued_at` and `root_sig`. `root_sig` is a device-cert signature by the root key, so the hub can rebuild the cert record.
- **`device.revoke`** carries the full signed `Revocation`. The spec's `{device_id, sig}` didn't say what is signed or by whom.
- **`acl.set`** `audience` can be `null`, which clears a rule so the path inherits again.
- **`connect.offer`** carries `from_user`, `from_root_pubkey` and `from_chain`, so the uploader can verify the downloader's cert chain (§7 `hello` checks) without another hub round trip.
- **`connect.request` / `connect.offer` / `connect.answer`** carry udx `stream_id`s and both sides' candidates (M4). The forwarded `connect.answer` adds the owner's identity (`to_user`, `to_root_pubkey`, `to_chain`) and the transfer token the downloader presents in `hello` (ADR 0010).
- **Peer `get` ranges** are chunk-index ranges `[start, end)`.
- **`hello.purpose`** (M6) is `file` (the default) or `preview`. A preview session serves `thumb.get` and `peek` for any hash, and the uploader checks each one (ADR 0012).
- **`connect.failed`** c→h carries raw `observations`. The hub combines both sides' observations into the single diagnosis (`cause`, `easier_fix`, `you`, `them`). `easier_fix` also allows `either` and `none`.
  - Since M5, the downloader's c→h `connect.failed` is a request, and the reply is the h→c `connect.failed` with the diagnosis. The owner's report is answered with `ok` (ADR 0011).
- **`NatType`** adds `none` (no NAT: the hub saw one of our own addresses) and `blocked` (no reply from either probe port) to `endpoint_independent | symmetric | unknown` (M5, ADR 0011).
- **`welcome.nat_probe_ports`** are the ports the hub actually bound, so a hub configured with port 0 (tests) still reports usable ports.
- **`Candidate`** is `{kind: lan|public|mapped|ipv6|advertised, host, port}`. `host` must be an IP literal (ADR 0001). The udx stream id is added in M4.
- **Link codes** are formatted `XXXX-XXXX` (Crockford-ish alphabet, uppercase).
- **`watch` / `unwatch`** (M7) are answered with `ok`. The path is normalised to a folder. After `ok`, the hub sends the catch-up as one or more `watch.event`s. Every page but the last carries the old cursor as its `rev` (ADR 0013).
- **`SharePath`** is `ShareName/rel/path`. It rejects absolute paths, `..`, `.`, empty segments, backslashes and NUL. A trailing `/` marks a folder (ACL rules, browse, watch).

## Peer frame encoding

Each frame is `u32be frame_len | u32be header_len | msgpack header | raw payload`.

- The header is `{t, ...fields}`.
- `manifest.chunk_hashes` is a single binary blob of concatenated 32-byte hashes, not an array.
- Frames larger than 1 MiB + 64 KiB are rejected before they are buffered.
