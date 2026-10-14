# ADR 0019 — The synced folder

- Status: accepted
- Date: 2026-10-13

Owner request: a quick way to keep one folder the same on all your computers. They had built it by hand: a `Communal` folder on each computer, shared with themselves, and each computer subscribed to the others' with deletions mirrored. This automates that and makes it safe. There are no protocol changes; ADR 0013's subscriptions do the moving.

## What it is

- **The synced folder is the share named `Communal`** on each of your computers (`SYNC_SHARE`). Turning it on (`PUT /v1/sync {path?}`, default `~/Communal`) creates the folder if needed and shares it under that name on every hub you're on, with the usual "only me" rule. Turning it off (`DELETE /v1/sync`) stops sharing it and stops following the others. **Nothing is deleted anywhere.**
  - Using the share name, rather than a new hub-side flag, means a hand-made setup like the owner's is already a synced folder: its hand-made subscriptions between `Communal` folders are taken over (marked `sync`, deletions mirrored) instead of duplicated.
  - The cost: any share named `Communal` is synced. The app guide says so, and in My shares that share has its own panel instead of a row.
- **A marker file.** The hub only knows files, so an empty folder would be invisible, and deleting the last file would look like the computer had stopped syncing. Each synced folder holds `.communal-sync`, the one dotfile the indexer shares (`SYNC_MARKER`). Its content is the same everywhere, so the copies the computers trade never clash. It's recreated if deleted. The Library hides dotfiles.
- **Finding each other.** `SyncFolder` (`packages/core/src/sync-folder.ts`) checks every 60 s, on every sign-in, and when devices or the library change: it lists your devices (`devices()`), browses each one's root, and follows `Communal/` on each one that shares it, through the first hub where it's visible, into this computer's own synced folder. A computer that stops sharing it, or is revoked, is no longer followed. Computers you link later join as soon as they turn it on.
- **Only your own computers.** Your other devices can watch any of your folders (ADR 0013), so no rule is needed and nobody else is involved.

## Two-way sync on top of subscriptions

Each computer follows each other one (a full mesh: n·(n−1) subscriptions), so every change arrives several times. Subscriptions marked `sync` behave differently from ordinary ones in four ways (`addedSync` / `placeSync` in `subscriptions.ts`):

1. **One queue for all of them.** They all write into the same folder, so their events are applied one at a time, never two at the same path at once.
2. **Staging.** Downloads and copies go into `.communal-incoming/` inside the synced folder first: the same volume, so placing is a rename, and a dot folder, so nothing half-placed is ever indexed or shared. The source's modification time is kept on the file (synced copies need it to decide conflicts alike).
3. **One download for one new file.** When a second computer offers the same content at the same path while a download is under way, it waits for that download instead of starting another (`syncPending`). Shared downloads aren't cancelled while another source still waits for them.
4. **What's at the destination decides, at the moment of placing:**
   - **The same content:** recorded, nothing written. This is the usual case, with every computer echoing every other one's files.
   - **A version some synced computer gave us, untouched since** (`synced()`: the file still matches a stamp any `sync` subscription recorded at that path): replaced, the old version to the OS trash.
   - **A version this computer already had at that path, arriving late** (`stale()`: another sync subscription recorded this hash there) while the file here was changed or deleted since: an echo, not news. Nothing is written, and the change here travels on. Without this, a fast edit or a deletion lost the race with an older copy still in flight from a slower computer, and the deleted file came back or a needless conflict copy appeared.
   - **Something changed here that isn't synced yet: a conflict.** The newer version (by modification time, ties broken by hash) keeps the name. The other is kept beside it as `name (conflicted copy YYYY-MM-DD abc123).ext` (`conflictName`), named from its own hash and date. Every computer decides alike and names the copy alike, so they end with the same files. With per-device names (`name (1).ext`) two computers' copies would never match, and a two-way pair produced new copies forever.
   - **Deletions** apply to whatever is at that path here. A synced version goes to the trash. A file changed here and not yet synced means the deletion and an edit crossed: the edit is kept under its `conflictName`, and the path is gone. Keeping it under its own name was tried first, and it diverged: the other computers had already deleted their copies, and with nothing new to announce they never fetched it again.
   - **The same crossing, seen from the other side:** a computer that deleted a file and then hears of a newer edit to it fetches the edit (an edit beats a deletion it can tell is older). Either way both computers end with the edit and agree on its name: restored under its name, or as a conflicted copy, depending on which side heard first.
   - **Both sides at once** (2026-10-14): the editing computer sets its edit aside while the other has already restored it under its name, and that restored copy comes back. The editing computer doesn't restore it again when it already holds that exact content under the conflict name it would give it, and nothing is at the name (`ownSetAside`). Without this check, an unlucky interleaving left both names on both computers.
   - **A computer that stops sharing its folder** makes the hub report every file as removed. Before applying removals, a sync subscription checks the source still lists `Communal` at its root (`stillShared`), and ignores them otherwise. Turning off one computer never empties the others.

### Known limits

- **No relay, as everywhere:** two computers sync only while both are online. A change on a laptop reaches the desktop the next time both are on, maybe through a third computer that had it meanwhile.
- **Concurrent delete and edit, three or more computers:** one that already mirrored the edit when the deletion reaches it trashes it like any synced file. The edit survives on the editing computer (as a conflicted copy) and comes back from there, and the trashed copy is in the OS trash. Without version vectors, crossings can't always be told from sequences.
- **Reverting while another computer edits** (content going back to a version that computer already had) can leave the two with different files at that name until the next change.
- **Renames with an edit** in between become a delete and an add.
- A hub that is down when a computer turns syncing on delays the others finding it until that hub (or another shared one) is back.

## Also fixed in the indexer

- **Folders moved into a share weren't hashed.** A folder moved in at once reached the indexer as one "folder appeared" event. `scan()` listed its files but never woke the hasher, so they stayed unhashed (and couldn't be downloaded) until something else changed. Placing synced files into new subfolders hit this every time. `scan()` now wakes the hasher when it finds new files (`index.test.ts`: "hashes the files of a folder moved into the share").
- **Files written just after a share was added could be missed** until the 15-minute rescan. That happened when they landed between the first scan and the watcher starting, or before macOS delivered the watcher's first events (under load, a little after "ready"). Turning on the synced folder and dropping a file in right away hit this. The indexer now scans the share again when its watcher is ready and once more 2 s later. These scans only stat files.
- A scan or batch still running when the indexer stopped could write to a closed store (an unhandled rejection in tests). Both now stop first.

## API, CLI, MCP, desktop

- `GET /v1/sync` → `{enabled, path, default_path, devices: [{device_id, name, hub, status, files}]}`; `PUT /v1/sync {path?}`; `DELETE /v1/sync`. `GET /v1/subscriptions` rows carry `sync`.
- CLI: `communal sync [status]`, `communal sync on [folder]`, `communal sync off`.
- MCP: `get_synced_folder`, `set_synced_folder {on, path?}`. Turning it on exposes nothing to anyone else, so it's an ordinary change tool.
- Desktop: a **Synced folder** panel at the top of My shares (turn on with a folder picker, open, which computers it's in step with and what's on the way, turn off). Its subscriptions aren't listed in Subscriptions.

## Tests

`test/integration/m10-sync-folder.test.ts` (real hub, linked devices, an injected trash):

- Three computers with different starting files end up with all of them; a file in a new folder on one reaches the others, downloaded at most once per computer; an edit replaces the others' copies (old ones to the trash); deleting a folder trashes it everywhere; nothing in `.communal-incoming` ever reaches the hub.
- Two computers edit the same file while one is offline: both end with the newer version at the name and the older as the same `conflicted copy`, and no more copies appear afterwards. Then one deletes it while the other, away, edits it again: both end with the same files and the edit kept, under its name or as a conflicted copy.
- A hand-made subscription between `Communal` folders is taken over; turning one computer off stops the other following it, with every file kept on both and nothing trashed.
