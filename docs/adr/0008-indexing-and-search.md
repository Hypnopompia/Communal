# ADR 0008 — Indexing, index sync, search and the local API

- Status: accepted (M2)
- Date: 2026-10-12

## File hash

- Files are split into **1 MiB chunks**, the transfer chunk size from HANDOFF §7. `chunk_hash_i = BLAKE3(chunk_i)`, and the file hash is `BLAKE3(chunk_hash_0 ‖ chunk_hash_1 ‖ …)`, written as lowercase hex. An empty file has no chunks, so its hash is `BLAKE3("")`.
- This is the "chunk-hash list must hash to the root" property from §7: a downloader checks the manifest against the file hash, then checks each chunk against the manifest. The client stores the concatenated chunk hashes, which are the manifest for M4.
- **Library:** `hash-wasm` at about 1.1 GB/s on Apple Silicon. That's 15× faster than `@noble/hashes` and needs no native build. Each worker reuses its hasher instances and a 1 MiB read buffer.

## Local index (core)

`index.db` (better-sqlite3, WAL, `synchronous=NORMAL`) has four tables:

- `shares`: name, local root, and the hubs the share is published to
- `files`: share, relative path, size, mtime in ms, mime, kind, hash, chunk hashes
- `changes`: an append-only log of upserts and removes
- `hub_sync`: per hub, the rev and the last change-log entry that hub acknowledged

Local paths exist only here. Hubs see `ShareName/rel/path`.

**Scanning** walks each share and only stats unchanged files. Files that are new or whose size/mtime changed get type detection. Rules:

- **Never followed or indexed:** symlinks (they could point outside the share), dotfiles and dot-folders (`.git`, `.DS_Store`), OS junk (`Thumbs.db`, `desktop.ini`) and partial downloads (`*.part`, `*.crdownload`, …).
- **Skipped (with a log entry):** names the hub would reject (backslashes, etc.).
- **Logging:** errors log the error code, never the message, because file-system messages contain full local paths (HANDOFF §14).

**Type detection:** the `file-type` magic-byte result wins when it exists. Otherwise the extension decides (`mime-types` plus code/text/disk-image extension lists), so `.ts` without MPEG-TS magic is TypeScript, not video. Generic containers (zip, OLE) take the more specific extension type (docx, xlsx, epub).

**Watching:** chokidar events are batched for 2 s, then each dirty path is re-checked with `lstat`.

- **Periodic full rescan,** every 15 min by default (`COMMUNAL_RESCAN_MINUTES`). It catches what the watcher misses. Docker Desktop bind mounts dropped delete events in testing, and network shares often deliver no events at all.

**Hashing** runs in the background, 4 files at a time. Results are committed in batches of up to 200, and a hash is only stored if the file still has the size/mtime that was hashed. Files are indexed without a hash first and the hash arrives in a later delta (HANDOFF §5).

## Index sync (per hub)

- **On sign-in:** if the `index_rev` in `welcome` differs from the client's stored rev for that hub, or there is no stored rev, the client sends a full **snapshot** in pages of 5,000. Otherwise it sends **deltas** built from the change log since that hub's last acknowledged entry. Each delta is coalesced to the final state of every path, and only shares published to that hub are included. Removals are always sent; the hub ignores paths it doesn't have.
- **Hub replies** to a delta with `index.ack {rev}`, or with `index.resync` if `base_rev` doesn't match. The client then sends a snapshot.
- **Snapshots** are staged in `entries_staging` and swapped in atomically on the last page. Pages that arrive out of order are rejected.
- **Changing which hubs a share is published to** triggers a fresh snapshot to each affected hub. The pending resync is tracked in memory, so a snapshot already in flight can't swallow it (a race found in testing).
- **Index messages carry no `device_id`.** They always apply to the session's own device, so a client can't touch another device's index.

## Hub search, browse, sources

- **Schema:** `entries(device_id, path, dir, name, …)`, with an FTS5 external-content table on `name` (`unicode61 remove_diacritics 2`) kept in sync by triggers.
- **Query building:** user text becomes AND-ed prefix terms (`"alien"* "1979"*`). Every non-alphanumeric character is a separator, so user input can never inject FTS syntax.
- **Search** groups results by hash and ranks by best `bm25`, then by newest. `bm25()` can't be used inside an aggregate, so ranking happens in a `MATERIALIZED` CTE. It **returns only hashed entries**, because unhashed files can't be downloaded. Browse shows them.
- **Cursors** are opaque offsets.
- **Access:** every query goes through `Catalog.visible()`, the single place to extend in M3.
  - In M2 a user sees only their own non-revoked devices' entries, and never entries owned by banned users.
  - Browsing a device you can't see returns the same `not_found` as a device that doesn't exist.

## Cross-hub search (core)

`searchAll` sends the query to every connected hub at once and merges hits by hash.

- **Ordering:** the hubs' result lists are interleaved round-robin, so one hub can't fill the first page.
- **Sources** carry their hub id, because that hub brokers the transfer.
- **Partial results:** per-hub status, with each hub's cursor or the reason it's unavailable.

## Local API

- **Transport:** HTTP+JSON. On headless, it's a Unix socket at `<data>/api.sock`, mode `0600`, inside the `0700` data directory. For the desktop app (M9), it listens on `127.0.0.1` with a random bearer token, compared in constant time.
- **Routes:** `/v1/status`, `/v1/hubs`, `/v1/shares` (including `PUT …/hubs`), `/v1/search`, `/v1/browse`.
- **CLI behavior:** the CLI talks to the daemon through this API. `init` and `hub add` also work while the daemon is stopped. A second daemon on the same data directory refuses to start.

## Measured (M4 Pro, 100,000 small files)

| Step                          | Time                                                  |
| ----------------------------- | ----------------------------------------------------- |
| Scan + type detection         | 5.0 s                                                 |
| Hash everything + sync to hub | 21 s total, sync finishing ~0.1 s after the last hash |
| Search over 100k entries      | ~10 ms                                                |

Early versions spent 82 s on hashing. The cost came from one fsync'd commit per file, a fresh 1 MiB buffer per file, and hashing one file at a time.
