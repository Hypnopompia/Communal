# ADR 0004 — Protocol catalog: additions and clarifications

- Status: accepted (M0); revisit as milestones land
- Date: 2026-10-12

`packages/protocol` has a zod schema for every message in HANDOFF §5 and every frame in §7. There is one schema map per direction (`clientBodies`, `hubBodies`), because some types carry different bodies each way. For example, `connection.request` goes c→h as `{user_id}` and h→c as `{user: UserSummary}`. This ADR lists where the schemas go beyond or pin down the HANDOFF catalog.

## Added message types

### Hub

| Type                                                  | Why                                                                                                                           |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `ok` (h→c)                                            | Generic reply for commands that return no data (`acl.set`, `group.delete`, `watch`, …).                                       |
| `user.results`                                        | Reply to `user.search`. The catalog marks it c→h→c but doesn't name the reply.                                                |
| `connection.listing`, `group.listing`                 | Replies to `connection.list` and `group.list`.                                                                                |
| `device.list` / `device.listing` / `device.revoked`   | The Settings → Devices screen (§11) and revocation distribution (§4) need them.                                               |
| `link.denied`                                         | Tells the new device its claim was denied.                                                                                    |
| `acl.replace` (c→h, M3)                               | Full per-hub rule set for the device, sent on sign-in; keeps the hub in step with the client's authoritative copy (ADR 0009). |
| `library` / `library.listing` (M9)                    | Devices the viewer can browse, with owner, `online` and `seen`: the desktop Library (ADR 0016).                               |
| `browse.follow` / `browse.changed`, `library.changed` | Live browsing: the device a session is looking at, and a data-free hint that its listing changed for that viewer (below).     |
| `admin.*` (ADR 0020)                                  | Hub administration from the client: users, approve, ban, unban, settings, graph, audit log, and the `admin.changed` hint.     |
| `device.message` (c→h and h→c, ADR 0023)              | Remote control: a sealed, signed message for another device of the same account, which the hub forwards and can't read.       |

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
  - Since M8, `device.revoke` and `device.revoked` carry a **revocation proof** `{revocation, chain}`, where `chain` is the signer's cert chain. Any hub can then check a proof whose signer never joined it (ADR 0014).
- **M8 (ADR 0014):**
  - `link.approve` and `link.done` carry an optional `sealed` box: the account's hub list, encrypted to the new device's key.
  - `link.claim` is answered `ok`, and `link.done` / `link.denied` follow as events.
  - `account.restore` is answered with `account.created`.
  - `device.listing` entries carry `root`.
  - `connect.offer` carries `from_revocations` and `connect.answer` carries `to_revocations`: the peer account's proofs, at most 256.
- **M9 (ADR 0015):** each source in `search.results` and `sources.list` carries `seen` (`now | today | week | month | older`), and `search` takes an optional `available` filter (`now | today | week | month`).
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
- **`browse.follow`** takes `{device_id}` (or `null` to stop) and is answered with `ok`, or `not_found` exactly like `watch` when the viewer can see nothing on the device. It lives in the hub session (one device per session, memory only), so core renews it after every sign-in. The hub sends `browse.changed {device_id}` when an index change touches an entry or tombstone the viewer can see (rev newer than the last hint), and after a rule, connection or group change that could change what they see. It never carries data, and changes to hidden files never cause one. Entries carry a second rev, `mrev`, that also moves on metadata-only changes (a thumbnail or media metadata arriving), so those send the hint too. `rev`, which watches use, still moves only when the content changes.
- **`library.changed {}`** follows any `library` request: the hub remembers which devices it listed (memory only) and re-checks a device whenever its index, its rules, or the owner's connections or groups change, or it's added, revoked or its owner banned. When the list would differ, it sends the hint, and the client asks again. Unbans aren't announced (the admin CLI only edits the database); the next refetch picks them up.
- **`challenge.name`** (optional) is the hub's readable name, set by its admin (`communal-hub set name …`). It's in the challenge so a client sees it before signing in (an account waiting for approval). Clients keep the last one they saw and show the hub's host name when there's none.
- **`connection.listing`** entries for accepted connections carry `online` (any of their computers) and `seen` (the latest, bucketed like `library.listing`). Pending requests carry neither, since presence is only visible to accepted connections.
- **Admin messages (ADR 0020):**
  - c→h `admin.users` → `admin.user.listing`: accounts with their devices, with file counts and bytes per device, and the NAT side of a signed-in device's network profile. No paths or addresses.
  - `admin.approve`, `admin.ban {user_id, reason?}` and `admin.unban` → `ok`. Repeating one is a no-op. A client can't ban itself or another admin (`forbidden`).
  - `admin.settings.get` / `admin.settings.set {join_mode?, name?}` → `admin.settings`. `name: null` clears the name.
  - `admin.graph` → `admin.graph.listing`: every connection, with no groups or rules.
  - `admin.log {before?, limit}` → `admin.log.listing {entries, more}`, newest first.
  - h→c `admin.changed {}` goes to signed-in admins when an account or device is added or revoked, or after an admin action.
  - Non-admins get `bad_request` "unknown type …", the same reply an older hub gives.
  - `welcome.admin` says whether the account administers the hub.
- **Remote control (ADR 0023):**
  - c→h `device.message {to, sealed}` → `ok`, and the target gets h→c `device.message {from, sealed}`. The hub forwards only to another device of the sender's account that is online and not revoked. Anything else, including another account's device, is `not_found`, so device ids can't be probed. It keeps nothing.
  - `device.listing` entries carry optional `pubkey` and `chain`, so a device can check another device's chain itself before sealing to it.
  - `Platform` adds `android`. Desktop clients older than this release can't read a `device.listing` that includes a phone.
- **`SharePath`** is `ShareName/rel/path`. It rejects absolute paths, `..`, `.`, empty segments, backslashes and NUL. A trailing `/` marks a folder (ACL rules, browse, watch).

## Peer frame encoding

Each frame is `u32be frame_len | u32be header_len | msgpack header | raw payload`.

- The header is `{t, ...fields}`.
- `manifest.chunk_hashes` is a single binary blob of concatenated 32-byte hashes, not an array.
- Frames larger than 1 MiB + 64 KiB are rejected before they are buffered.
