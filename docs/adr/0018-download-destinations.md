# ADR 0018 — Downloads folder, "Save to…" and folder downloads

- Status: accepted
- Date: 2026-10-13

The owner asked for downloads organized by kind (audio → Music…), whole-folder downloads, and re-sharing into shared folders (`docs/plans/downloads.md`). After looking at the design, **the owner chose a simpler first step**: let people choose where things go as they download them, and get real feedback before adding rules. There are no protocol changes.

## What's built

- **A downloads folder people choose.** `SavedSettings.downloads_dir` in `settings.json`, set through `PUT /v1/settings/downloads {dir}` (`null` goes back to the host's folder: `~/Downloads/Communal` on the desktop, `COMMUNAL_DOWNLOADS` or `<data>/downloads` headless). It must be an absolute path and is created if missing. `Downloads` and `Subscriptions` read it on each use, so a change applies to the next download without a restart. Subscriptions use it only for their default destination, as before.
- **"Save to…"** next to every Download button (Library list rows, search results, the preview dialog). It opens the system folder picker at the current downloads folder and passes `dest` to `POST /v1/downloads`, which already took one. Cancelling the picker does nothing and shows no toast.
- **Folder downloads.** `POST /v1/downloads/folder {hub, device, path, dest?}` downloads a folder and its subfolders once into `<dest or downloads folder>/<folder name>/…`, keeping the structure. The Library has **Download folder** next to **Subscribe to this folder**, with a dialog showing where it goes (Change… picks another folder).
  - **Listing:** a recursive `browse` walk, one request per folder, so the hub's access checks apply as for any browse. No new hub message. Capped at 10,000 files (`FOLDER_MAX_FILES`); bigger folders get a clear error suggesting a smaller folder or a subscription.
  - **Content already here isn't fetched again.** A file already at its place with the same content (checked against the index, else by hashing) is skipped, and so is one already downloading there. Same-hash content anywhere in your shares is copied, with `COPYFILE_FICLONE` so APFS and btrfs clone it instead of using more space. Hard links were rejected: editing one copy would change the other.
  - **Clashes:** a different file with the same name gets `name (1).ext` (`uniquePath`), as single downloads do.
  - **Unhashed files** ("still being prepared" on the owner's side) are left out and counted, so the dialog's result says so. Running the download again later fetches only what's missing.
  - There's no grouping in Transfers yet: each file is its own row. The reply counts what was queued, copied, skipped and left out, and the app shows that as a toast.
- CLI: `communal get-folder <device> <path> [--hub] [--dest]`, `communal download-dir [dir] [--reset]`. MCP: `download_folder`, `set_downloads_folder`, and `get_settings` now includes the downloads folder.

## Not built, on purpose

From the handoff, waiting for feedback:

- **Destination rules by kind** (audio → Music). People pick a folder with Save to… instead.
- **The re-share warning.** Downloading into a shared folder still re-shares the files with that folder's audience, as before. The handoff's open question (warn, or default re-shared files to "only me", or to the narrower audience) was decided in ADR 0021: warn before saving into a shared folder.
- **Refreshing sources mid-download**, transfer groups in the Transfers screen.

## Tests

`test/integration/m10-downloads.test.ts`: the chosen folder is used and survives a restart, Save to… wins, relative paths are refused, `null` resets; a folder download recreates the tree, copies content already in a share (only two transfers for three files), skips everything on a second run, and honours `dest`; folders hidden by rules, missing folders and this computer's own folders are refused with nothing queued.
