# Plan: download destinations, folder downloads and re-sharing

Status: **partly built, the rest on hold** (2026-10-13). The re-share question is decided: warn before saving into a shared folder (ADR 0021). The owner chose a simpler first step: a downloads folder they choose, "Save to…", and whole-folder downloads. See ADR 0018. Rules by kind, the re-share warning and the rest of this plan wait for user feedback. Keep this as the plan if they're picked up again.

## What the owner wants

> I might want mp3 downloads to go into my Music directory. I also might share my whole Music directory, so we need to help with keeping things organized. Then it's an easy matter of finding an album on someone's shared list and downloading the whole directory of mp3s to my Music directory, which then gets reshared to Communal, and allows for multiple sources of downloading file chunks.

Three features, in order of value:

1. **Download destinations by kind.** Each download lands in a folder chosen by its kind (audio → `~/Music`, video → `~/Movies`…), falling back to the downloads folder.
2. **Download a whole folder.** One action fetches an album (a folder and its subfolders), keeping its structure under the destination.
3. **Re-sharing.** When the destination is inside one of your shared folders, finished files are indexed and published like any other shared file. Everyone downloading that content then has another source.

## How things work today (read these before designing)

| Piece                     | Where                                                                                                                                                                             | What matters here                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Download entry point      | `CommunalCore.download()` in `packages/core/src/core.ts`                                                                                                                          | `(hash, {name?, destDir?})`. With no name, it takes the first source's file name from `sources`. `destDir` defaults to `CoreOptions.downloadsDir` (desktop: `~/Downloads/Communal`; headless: `<data>/downloads` or `COMMUNAL_DOWNLOADS`).                                                                                                                                                                     |
| Download engine           | `packages/core/src/transfer/downloader.ts` (`Downloads`)                                                                                                                          | One transfer is one file. Progress goes to `<name>.part` plus `<name>.partmap` in the destination; on success `uniquePath()` renames to the final name (`name (1).ext` on clashes). **Sources are fetched once per attempt** (`sources()` at the start of `run`). A copy that appears mid-download isn't used until the next attempt.                                                                          |
| Transfer rows             | `transfers` table in `packages/core/src/index/store.ts` (`TransferRow`)                                                                                                           | `dest_dir`, `name`, `final_path`, `state`, `diagnosis`. There's no grouping column yet.                                                                                                                                                                                                                                                                                                                        |
| Local API                 | `POST /v1/downloads {hash, name?, dest?}`, `GET /v1/downloads` in `packages/core/src/api/server.ts`                                                                               | Rows carry live `sources` (per-source speeds).                                                                                                                                                                                                                                                                                                                                                                 |
| Folder walking            | `packages/core/src/subscriptions.ts`                                                                                                                                              | Subscriptions already download a folder tree, keep its structure (`target()`: each path segment through `safeName`), **reuse local copies with the same hash instead of downloading** (`localCopy()`: subscription files, then `store.anyCopy(hash)` across your shares), and never touch files you changed. They list the folder with the hub's `watch` catch-up (everything since rev 0), not with `browse`. |
| Browsing                  | `Catalog.browse()` in `apps/hub/src/catalog.ts`; `GET /v1/browse`                                                                                                                 | One folder level per call (`dirs` + `files`), filtered by `Catalog.visible()`.                                                                                                                                                                                                                                                                                                                                 |
| Indexing your own folders | `packages/core/src/index/indexer.ts`                                                                                                                                              | A file written into a shared folder is picked up by the watcher, plus a per-folder reconcile since the last fix, plus a periodic rescan. `.part`, `.partmap`, `.crdownload` and dotfiles are ignored (`isIgnored`), so **a half-downloaded file is never shared**. It's hashed in the background; once it has the same hash, the hub lists it as another source.                                               |
| Access rules              | `effective()` logic in core (`setRule`), mirrored on the hub (`entries.rule_path`, ADR 0009)                                                                                      | A new file inherits the nearest folder rule above it, else "only me". **A downloaded file dropped into a shared folder therefore takes that folder's audience automatically.** That's the main design risk; see decision 3.                                                                                                                                                                                    |
| Persisted settings        | `CommunalCore.updateSettings()` / `settings.json` (`SavedSettings`)                                                                                                               | The place for download rules. They're shared by desktop and headless and take precedence over host defaults (ADR 0016).                                                                                                                                                                                                                                                                                        |
| Desktop UI                | `apps/desktop/src/renderer/src/`: `ui/files.tsx` (`useDownload`, `SubscribeDialog`), `screens/Library.tsx`, `screens/Search.tsx`, `screens/Transfers.tsx`, `screens/Settings.tsx` | Downloads start from the file grid (double-click), the preview dialog and search rows. Wire types live in `api.ts`.                                                                                                                                                                                                                                                                                            |
| CLI                       | `apps/cli/src/main.ts`: `communal get <hash> [--name] [--dest]`                                                                                                                   |                                                                                                                                                                                                                                                                                                                                                                                                                |
| MCP                       | `packages/mcp/src/server.ts`: `download_file`                                                                                                                                     | New tools go here (ADR 0017 scope: allowed).                                                                                                                                                                                                                                                                                                                                                                   |

## Proposed design (adjust in the ADR)

### 1. Destination rules

- `SavedSettings.downloads`: `{ default?: string; rules: { kind: Kind; dir: string }[] }`. Kinds are the existing `Kind` enum (`image`, `video`, `audio`, `document`, `archive`, `code`, `text`, `disk_image`, `other`). Start with kinds. Extensions can be added later if people ask.
- Resolution order in `CommunalCore.download()`: an explicit `dest` wins, then a rule for the file's kind, then `default`, then `CoreOptions.downloadsDir`. The kind comes from the hit or entry (`kind` is in search hits, browse entries and watch entries); pass it in, or look it up through `sources`.
- If a rule's folder is missing, create it, unless its parent is missing too (an unplugged drive). In that case fall back to the default and say so in the transfer row.
- API: `GET/PUT /v1/settings/downloads`. The desktop gets a Settings › **Downloads** tab, with one folder picker per kind and the default, prefilled from the OS folders (`app.getPath('music' | 'videos' | 'pictures' | 'documents')`). Headless: `COMMUNAL_DOWNLOADS` stays the default, and rules are set through the API, CLI or MCP.
- Subscriptions keep their own `dest` and don't use rules: a followed folder stays together.

### 2. Folder downloads

- `POST /v1/downloads/folder { hub, device, path, dest? }` creates a **download group** that keeps the folder's structure: `dest/<folder name>/<relative path>`, where `dest` comes from the rules (see decision 2).
- **Listing the folder:** walk it with `browse`, one request per subfolder, depth-first. Cap the number of files and folders (e.g. 10,000 files) and refuse with a clear error above that. That avoids a new hub message. (Alternative: a new hub `tree` message filtered by `visible()`. It's faster for big trees but needs protocol and ADR 0004 work and access-control tests.)
- Reuse what subscriptions already do: extract `target()` and `localCopy()` from `subscriptions.ts` into a shared helper. Same-hash content you already have is copied (or linked) instead of downloaded.
- Store: a `download_groups` table (`id, hub, device, path, dest_dir, created_at`) and a nullable `group_id` on `transfers`. `GET /v1/downloads` returns groups with their file counts and bytes. Cancelling a group cancels its files.
- Only entries with a hash can be downloaded (CLAUDE.md invariant). Report unhashed ones as "still being prepared" and leave them out. A later run could pick them up; decide whether to offer "refresh".

### 3. Re-sharing

This works on its own once the destination sits inside a shared folder: the indexer picks up the finished files, and the hub lists you as a source. The work is in making it visible and safe:

- Before downloading into a shared folder, the desktop says who will be able to see the files ("These will be visible to everyone on hub.example.com, like the rest of Music"). Show this in the folder-download dialog and in Settings › Downloads next to each rule. Use the existing audience text (`useAudienceText` in `screens/Shares.tsx`).
- See decision 3 for the audience question.

### 4. More sources during a download

This isn't required for the feature, but it's what makes re-sharing pay off for files downloading right now. In `Downloads.fetchChunks`, re-query `sources(hash)` every ~30 s (or on a `presence` event) and connect to new online sources up to `maxPeers`. The chunk pool, the bad-chunk tracking (`badFrom`) and the per-source stats (`liveSources`) already handle peers being added and dropped.

## Decisions to make first (owner input where marked)

1. **Rules by what?** Kind only, as proposed, or also extension/MIME? Is there a per-download "Save to…" override in the UI? (The API already takes `dest`.)
2. **Folder layout and clashes.**
   - Keep the owner's top folder name (`~/Music/<Album>/…`) or the owner's path from the share root (`~/Music/<Artist>/<Album>/…`)? The first is simpler and is what subscriptions do.
   - When the target folder already exists: merge into it, skip files with identical content (same hash), and rename on a name clash with different content (`uniquePath`)?
3. **Re-shared audience (owner decision).** A file you download into a shared folder inherits that folder's audience. The owner might have shared it with you alone, and you might share Music with the whole hub. Options:
   - (a) Allow it, and warn before downloading. This is the simplest and matches the owner's request.
   - (b) Give re-shared files "only me" unless you widen them.
   - (c) Default re-shared files to the narrower of the two audiences.

   The hub can't help here: it doesn't know a local file came from someone else. Decided: (a), warn (ADR 0021).

4. **Duplicates.** Copy a local same-hash file into the destination, or hard-link it (same volume) or clone it (APFS `copyFile` with `COPYFILE_FICLONE`)? Cloning or linking saves space; plain copying is simplest.
5. **Listing:** a recursive `browse` walk with a cap, as proposed, or a new hub `tree` message?

## Work breakdown

1. Write the ADR (0018) with the decisions above; update ADR 0004 only if the protocol changes.
2. **Core:**
   - `SavedSettings.downloads` with resolution in `download()`.
   - Download groups (store tables and API).
   - Folder walk.
   - Shared `target()`/`localCopy()` helpers, with subscriptions refactored to use them.
   - (Optional) refreshing sources mid-download.
3. **API:** `GET/PUT /v1/settings/downloads`, `POST /v1/downloads/folder`, groups in `GET /v1/downloads`, `DELETE /v1/downloads/group/:id`. Update the renderer wire types in `apps/desktop/src/renderer/src/api.ts`.
4. **Desktop:**
   - A Settings › Downloads tab.
   - Library: "Download folder" next to "Subscribe to this folder", with a dialog showing the destination, the audience warning when it's inside a share, and the count and size.
   - Transfers: folder groups with a combined progress bar, expandable to files.
   - Search: downloads follow the rules automatically.
5. **CLI:** `communal get <hash>` uses the rules; `communal get --folder <device> <path> [--dest]`; `communal downloads rules [list|set <kind> <dir>|clear <kind>]`.
6. **MCP:** a `download_folder` tool, plus `get_download_rules` and `set_download_rule`, described so the agent confirms re-shared audiences with the user.
7. **Docs:** the site's `guide.html` (Transfers and Settings sections, a new "Organizing downloads" section), `cli.html`, `agents.html` (tool table); `CLAUDE.md`; a progress entry.

## Tests (follow the repo's patterns)

- **Core unit tests:** rule resolution (explicit dest > kind rule > default > `downloadsDir`); a missing rule folder falls back.
- **Integration** (`test/integration/m10-downloads.test.ts`, real hub plus two or three cores, short timers, `until()` polling, no sleeps):
  - Downloading an audio file lands in the audio rule's folder.
  - A folder download recreates the tree. Same-hash files already present are copied, not downloaded; check that no transfer was created for them.
  - **Re-share:** Bob downloads Alice's album into his shared Music (audience `hub`), then waits until the hub lists Bob as a source for each hash. Carol then downloads from both: two sources in `liveSources`, and both upload logs non-empty (like the M4 multi-source test).
  - Losing access mid-folder-download stops the remaining files, and nothing already downloaded is deleted.
- **Hub:** only needed if a `tree` message is added. Then it needs access-control cases in `catalog.test.ts` (visible entries only, invisible folders indistinguishable from missing ones).
- Close with the full `pnpm check` (no `M2_FILES`).

## Done when

- A downloaded mp3 lands in the music folder without the person choosing a folder.
- Downloading an album folder gives `~/Music/<Album>/…` with the same structure, and files the person already had aren't downloaded again.
- With `~/Music` shared, the album shows up as a source for others, and a third person's download of it uses both computers at once.
- The person is told who will see re-shared files before downloading, as the ADR decides.
