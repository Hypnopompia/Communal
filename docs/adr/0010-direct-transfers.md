# ADR 0010 — Direct transfers: brokering, hole punching, verification, resume

- Status: accepted (M4)
- Date: 2026-10-12

## Brokering (HANDOFF §8) — never a relay

1. **The downloader sends `connect.request`** with `{target, hash, session_id, stream_id, candidates}`. The stream id and candidates are additions to HANDOFF.
2. **The hub checks the request.** The requester must be able to see an entry with that hash on that device (`Catalog.canFetch`, so the same visibility rule as search). If not, the reply is `not_found`, exactly as for a missing file. An offline owner gets an immediate `connect.failed {cause: peer_offline}`.
3. **The hub mints a token** `{session_id, from, to, hash, exp: now+300s}` signed with the hub key, and sends `connect.offer` to the owner. The offer carries the token, the requester's identity (`from_user`, `from_root_pubkey`, `from_chain`), its stream id and candidates.
4. **The owner answers** with `connect.answer {stream_id, candidates}`. Only the device the offer went to may answer. The hub forwards the answer to the downloader with the owner's identity (`to_user`, `to_root_pubkey`, `to_chain`) and **the same token**. The downloader presents that token in `hello`.

Brokered sessions expire with their token. A session id can't be reused while it's live.

## Transport and hole punching

- **One UDP socket per device** carries every udx stream. The port is set by `COMMUNAL_PEER_PORT`, or chosen by the OS.
- **Candidates:**
  - LAN IPv4 addresses
  - global IPv6 addresses
  - operator-advertised addresses (`COMMUNAL_ADVERTISE_ADDR`, IPs only)
  - the **public mapped address**, learned by probing each hub's UDP responder _from the peer socket itself_, so the mapping it reveals is the one punching will use. This is a minimal part of M5's probe, pulled forward so M4 works across NATs.
- **Punching:** both sides send small `CMNL1` datagrams (punch, and echo in reply) to every candidate of the other every 100 ms. The first address heard from is a working path; through a NAT, that's the other side's mapped address. After a 150 ms grace period the best path wins: LAN first, then IPv6, then the rest.
- **The udx stream then connects** to that path, with Noise XX over device keys on top.
- **Peer checks:** each side verifies that the peer's key is the device the hub named, and that its cert chain leads to the account root the hub named (with `userId(root)` matching).
- **Safety:** punch datagrams are only answered for sessions we're expecting (no reflection), and probe replies are only accepted from the address probed.
- **Dead peers:** keepalives every 5 s, and the connection drops after 20 s of silence.

## Uploader (HANDOFF §7 `hello` checks, in order)

1. **Token:** the `hello` token must carry a valid signature from the **pinned key of the hub that brokered this session**. It must be unexpired, addressed to us and from the authenticated peer, and must be **the token issued for this exact session**. That blocks replaying another session's token. Failures return `denied {reason}`: `bad_token`, `expired`, `wrong_target` or `wrong_sender`.
2. **LAN-only** (`lan_only`), if enabled.
3. **This device's own rules for that hub** (ADR 0009, `AccessOracle`).
   - Own account: always allowed.
   - `hub`: allowed.
   - A list of users or groups: the requester must be listed or in a listed group, **and** connected according to that hub. Connections and groups are fetched from the hub and cached for 30 s, and the cache is dropped on any `connection.*` event.
   - The first local copy the requester may have is served.
   - A refusal looks the same whether the file is missing or forbidden, and is logged as `denied`.
4. **The file must be unchanged since it was hashed** (size and mtime). Otherwise `not_found`.
5. **Concurrency:** at the limit (default 3), the reply is `busy {retry_after_s}`. A shared token-bucket bandwidth cap applies too.

**Upload log:** one row per session in the local `upload_log`. `completed` means every chunk the peer asked for went out _and_ the peer then closed cleanly. Resumed and multi-source downloads ask each uploader for only part of the file, and a crashed downloader never closes cleanly. Otherwise the row is `partial`, `cancelled` or `denied`. Retention defaults to 365 days (`COMMUNAL_LOG_RETENTION_DAYS`).

## Downloader

- **Sources:** `sources {hash}` on every hub, merged by device. Up to 4 peers are connected at once. The first manifest that hashes to the requested hash is used.
- **Chunks:** `get {ranges}` uses chunk-index ranges `[start, end)`, with about 32 chunks in flight per peer.
  - Each chunk is checked against the manifest on arrival.
  - A bad chunk goes back to the pool and is avoided from that peer while another peer is available. A peer that sends three bad chunks is dropped.
  - A chunk outstanding for more than 30 s goes back to the pool. In the endgame, idle peers duplicate stragglers and the first good copy wins.
- **Resume:**
  - Data goes to `<name>.part`, and progress to a `<name>.partmap` bitmap that is allocated full-size up front. A short bitmap file had been treated as stale, which threw away progress (a bug found in testing).
  - On restart, only missing chunks are requested.
  - The indexer ignores `*.part` and `*.partmap`.
  - On completion the file is fsynced and renamed, with ` (1)` added on a name clash.
- **Waiting:** with no source online, or every source busy or refusing, the download is `waiting` and retries every 30 s, and immediately when any device comes online.
- **File names from the network are untrusted.** `safeName` reduces them to a plain base name, so `../../etc/passwd` becomes `passwd`.

## Bugs found while building it (now covered by tests)

- **Frames arriving before a listener was attached were dropped.** The downloader sends `hello` immediately after connecting. Channels now buffer frames until something consumes them (`subscribe`, `next`).
- **A peer's clean `end` didn't close the other side,** so uploads lingered until a timeout.
- **Closing peers while iterating the list they remove themselves from** left one connection open.
- **A retry scheduled from inside `run()`** was refused because the run still counted as active, so waiting downloads never retried.

## Test lab across NATs

`docker/compose.nat.yml` + `docker/nat/test.sh` (also a CI job):

- **Layout:** two clients on separate private networks, each behind an Alpine router doing `MASQUERADE` and dropping unsolicited inbound traffic. The hub is on a shared "public" network.
- **What it checks:**
  - the clients can't reach each other's private addresses
  - each learns its mapped address (`router-ip:41641`) through the hub's probe
  - a 12 MB file transfers intact, so only hole punching can have connected them
- **Docker detail:** the LAN networks must not be `internal`, because Docker drops off-subnet packets on internal bridges even when they're addressed to a router container. Clients replace their default route with the lab router instead.

M5 extends the lab with symmetric NAT, blocked UDP and offline cases for `connect.failed` diagnosis.

**Correction (M5):** the M4 lab result didn't prove hole punching. Each router's default route pointed at Docker's gateway on its LAN side. A punch to the other client's private (`lan`) candidate therefore left the router un-NATed, was routed by the Docker host straight onto the other LAN, and won, because LAN candidates rank first. The ping check only tested one direction. Two fixes followed:

- The routers now have no default route.
- Like a home router's WAN side, they drop unsolicited packets addressed to themselves. An accepted one leaves a conntrack entry on the public port, and the inside client's own punch is then NATed to a different port, so the holes never line up.

With both fixes, punching between two cone NATs works for real (ADR 0011, `docker/nat/test.sh`). The test now checks isolation in both directions.
