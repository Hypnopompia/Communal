# ADR 0013 — Folder subscriptions

- Status: accepted (M7)
- Date: 2026-10-12

HANDOFF §5 "Subscriptions", §10 (`watches`) and §12 M7. There are no protocol changes: `watch`, `unwatch` and `watch.event` are used as catalogued, and `watch` / `unwatch` are answered with `ok` (ADR 0004).

## Hub: what changed since a rev

HANDOFF asks for catch-up "from `since_rev`", but until now the hub kept only each device's current index and its rev, so it couldn't say what changed since an older rev. Two additions make that possible:

- **`entries.rev`:** the device's index rev at which the entry's _content_ last changed. An upsert keeps the old rev when the hash is unchanged, so metadata-only updates (thumbnails, tags) don't look like new files. Filling in a hash counts as a change, which is when a file becomes downloadable.
- **`tombstones (device_id, path, dir, rule_path, rev, at)`:** a row for every path that leaves a device's index, through a delta or a snapshot. A path is in `entries` or `tombstones`, never both.

Snapshots now behave like deltas. Commit upserts the staged rows (keeping unchanged revs) and tombstones the rows that vanished, instead of replacing everything. The 100k-file test is unchanged at about 23 s.

**Tombstones are kept for 180 days** (`HubDb.tombstoneRetentionS`) and pruned whenever the device's index changes. A watcher away for longer still gets every current file when it returns, but misses deletions from before the window.

## Hub: watch and watch.event

- **`watch {device_id, path, recursive, mirror_deletes, since_rev}`:**
  - The path is normalised to a folder (`Photos` → `Photos/`).
  - **Access check, like browse:** the watcher's own devices may watch anything. Anyone else needs at least one visible entry under the folder. Otherwise the answer is `not_found`, the same as for a folder or device that doesn't exist. Watching your own device is `bad_request`.
  - At most 1,000 watches per session (`rate_limited`).
  - The reply is `ok`, followed by the catch-up: everything that changed after `since_rev`. If `since_rev` is ahead of the device's rev (the hub's index was rebuilt), it starts from 0, meaning everything.
  - The watch is recorded in `watches` (HANDOFF §10) and is live for the session. **The client re-sends its watches after every sign-in, with its own cursor.** The table is a record for admins and for `unwatch`, not something the hub replays.
- **`watch.event` content** comes from `Catalog.watchChanges()`. It uses `Catalog.visible()` like every other query, so it's filtered for the watcher:
  - `added`: visible entries with a hash whose rev is newer than the cursor (the cursor 0 means all of them).
  - `removed`: visible tombstones newer than the cursor. Tombstones are re-tagged with their governing rule whenever rules change, just like entries. So a deletion is only told to people who could see a file at that path under the current rules.
- **Live events:** after every delta or snapshot from a device, each live watch on it is brought up to date. Empty updates aren't sent. The catch-up reply to `watch` is always sent, even when empty, so the client's cursor moves.
- **Paging:** at most 1,000 items per event. **Every page except the last carries the old cursor as its `rev`,** so a client that stores each event's rev never skips a page it didn't get.
- **Visibility changes re-announce everything.** A file that becomes visible (a rule widened, a connection accepted, a group gained a member) has an old rev, so a cursor-based update would never mention it. The hub therefore re-sends the full visible state to the affected live watches. `acl.replace` arrives on every sign-in, so this happens only when the rules actually differ. Clients skip what they already have.
- **Losing access is never reported as a deletion.** A file that becomes invisible simply stops being mentioned. Its later removal isn't sent either, unless access comes back.

Known limit: a tombstone's visibility follows the _current_ rules. If a folder is made public after a file in it was deleted, watchers can learn that the deleted path existed. Only the path leaks, never content, and only for paths under a rule that now grants them access.

## Client: subscriptions

`Subscriptions` (`packages/core/src/subscriptions.ts`) keeps two tables in `index.db`:

- **`subscriptions`:** hub, device, folder, recursive, destination, `mirror_deletes`, paused, the cursor (`rev`), and `status` (`ok` / `no_access`).
- **`sub_files`:** one row per owner path: hash, state (`pending` / `done` / `failed` / `removed`), the transfer, and **a stamp of our local copy** (`{path, size, mtime}` as we left it).

Behaviour:

- **Subscribing:**
  - `mirror_deletes` is chosen at subscribe time, as HANDOFF asks. The API requires it. The CLI asks `[y/N]` on a terminal and defaults to no otherwise.
  - The hub's `not_found` becomes "no such folder, or it is not shared with you", and nothing is saved.
  - The default destination is `<downloads>/<folder name>`.
- **On sign-in** every subscription that isn't paused re-watches from its cursor. A refusal marks the subscription `no_access` without deleting it, and refused subscriptions are retried every 10 minutes (`subscriptions.retryMs`), so regained access is noticed without a reconnect.
- **Events are applied one at a time per subscription, additions before removals.** The cursor moves only once the whole event is applied. Applying is idempotent, so replays after a crash or a repeated full re-send are harmless.
- **A new hash at a path:**
  - The hash is already there (`pending` or `done`): nothing to do.
  - Content we already hold is copied instead of downloaded: a file leaving in the same event, another subscription's copy, or a file in our own shares, checked by size and mtime like the uploader does.
  - **A move at the source becomes a local move** when `mirror_deletes` is on. Without it, the new copy is a copy and the old one is kept.
  - Otherwise a normal download (M4) is queued into the matching subfolder. Each path segment goes through `safeName`. While the owner is offline it waits, and it resumes when they come back.
- **A changed file** (new hash, same path): the new version downloads next to the old one. Once it's in, the old version goes to the trash and the new one takes its name. A download still running for the old hash is cancelled.
- **Deleted at the source:**
  - With `mirror_deletes`: our copy goes to the **OS trash**, never deleted outright, and folders left empty are removed.
  - Without it: the copy stays and the row becomes `removed`. If the same content comes back at that path, it's re-linked rather than downloaded again.
- **Local changes win.** A local copy whose size or mtime no longer matches its stamp (the user edited, moved or deleted it) is never trashed or replaced. Updates are saved alongside it instead. A file the user deleted locally isn't downloaded again.
- **Losing access:** the hub stops announcing anything, so no new downloads start and existing files stay. Downloads already queued for files no hub offers us any more now **fail** with `no longer available`, instead of waiting forever. This applies to every download, not only subscriptions. It triggers only when every joined hub answered `sources` and none lists the hash, even as offline. A hub that's down, or an owner that's offline, still means waiting.
- **Pause** sends `unwatch`. Resume re-watches from the cursor, so it catches up. **Removing** a subscription unwatches it and cancels its queued downloads. Files already downloaded stay. Leaving a hub removes its subscriptions.

### OS trash

`trash` (sindresorhus, v10) is used for the OS trash. On macOS it runs a small bundled binary (`macos-trash`), on Windows `windows-trash.exe`, and on Linux it implements the freedesktop.org trash spec in JavaScript (also in the headless image). **M9:** both binaries must be unpacked from the Electron asar. Tests inject a `trash` function (`CoreOptions.subscriptions.trash`) so they never touch the real trash.

## Owner side: renames keep their hash

A rename used to reach hubs as two separate changes: a removal, then (after re-hashing) an unhashed upsert, and finally the hash. Subscribers saw the deletion first, so with `mirror_deletes` they trashed their copy and then downloaded it again.

Now the indexer treats a file that appears with exactly the same size and millisecond mtime as one that disappeared in the same batch (a watcher batch or a scan) as **that file moved**. It keeps the hash, chunk hashes and media results (`IndexStore.adoptContent`). Ambiguous matches (two vanished files alike) are hashed afresh. The removal and the hashed upsert then go out in one delta and arrive in one `watch.event`, and the subscriber moves its copy. Owners also save re-hashing a renamed 40 GB folder.

The risk is a different file with exactly the same size and mtime replacing one in the same instant. Then downloads of the stale hash fail chunk verification (M4) instead of producing a wrong file, and the next edit or rescan with a new mtime fixes the index.

## Tests

- `apps/hub/src/watch.test.ts`: the access-control cases:
  - no session
  - invisible, missing and foreign folders, all answered alike
  - own devices see private folders
  - hidden files and their deletions never sent
  - a removed connection stops events without reporting deletions, and reconnecting re-announces the folder
  - banned owners
- `apps/hub/src/watch.test.ts`: catch-up and live events:
  - catch-up from `since_rev`, including deletions while away
  - a cursor ahead of the hub
  - snapshots as deltas
  - non-recursive watches
  - re-announcement only when rules actually change
  - `unwatch`
  - paging and cursor safety
  - tombstone retention
- `test/integration/m7-subscriptions.test.ts` (real hub and cores):
  - adds, deletes and folder removal propagate, with deletions going to the trash
  - catch-up after the subscriber was offline (an add, an edit and a delete)
  - `mirror_deletes` off keeps files, and locally edited files are never trashed
  - moves become local moves with no new transfer
  - queueing while the owner is offline
  - losing access: nothing new, nothing deleted, `no longer available`, `no_access` and then recovery, including the deletion missed meanwhile
  - the local API
- `packages/core/src/index/index.test.ts`: renames keep their hash, through the watcher and through a scan, and ambiguous ones don't.
