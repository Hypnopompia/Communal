# ADR 0021 — Agents, re-sharing, the first device and people on several hubs

- Status: accepted
- Date: 2026-10-13

These questions were open in `docs/questions.md`. The owner accepted the recommendation for each, and they're recorded here. Hub admin was decided at the same time and has its own ADR (0020).

## Decision

### 1. What AI agents get next

The ideas are in `docs/plans/agents.md`.

- **Build first:**
  - **Thumbnails as image content** in MCP.
  - **An access dry run.** Given a proposed rule change, it reports which files become visible or hidden, to how many people, on which hub. It never shows the owner anything they couldn't already see. The desktop app's audience picker can show the same preview.
- **Built (2026-10-13):** `view_thumbnails`, plus `preview_access` (`POST /v1/acl/preview`, core `previewRule`). The preview uses only this device's own rules, files, connections and groups. List rules count only accepted connections, since list grants only work while connected. A share not listed on the hub is reported as such, not as a widening.
- **A dry run isn't a confirmation.** An agent still asks the person every time an audience widens, and shows the dry run's result in the question. The server instructions and the `set_access`/`share_folder` tool descriptions say so.
- **Content leaving the owner's computer** (content search across friends' shares, peer queries) is limited to **snippets, never full text**. It comes only from shares whose owner opted in, and it's off by default. This is a constraint for later work. Nothing is built yet.

### 2. Re-sharing downloads

**Warn before saving into a shared folder.** Show a warning wherever a download is about to land in one of your shares:

- the folder-download dialog;
- Save to…, when the folder picked is inside a share;
- Settings › Downloads, when the downloads folder is inside a share.

The warning says who will be able to see the files, per hub, using the existing audience text.

**Built (2026-10-13):**

- **Core:** `exposure(dir, inside?)` (`GET /v1/exposure`) says which share a folder is in, even one that doesn't exist yet, resolving symlinks the way share roots are. It also gives the audience the files would get on each hub the share is listed on, with people named and a one-line summary. Dot-folders count as unshared, since they're never indexed.
- **The warning:** download, folder download and subscribe replies carry `reshared` when anyone but you would see the files, and the CLI prints it.
- **App:** Save to… asks first ("Save and share"). The folder download and Subscribe dialogs show the note, and the button becomes "Download and share". Settings › Downloads shows it when the downloads folder is shared.
- **MCP:** a `check_destination` tool, and the download and subscribe tools ask agents to pass `reshared` on to the person.

Re-shared files starting as "only me", or taking the narrower audience, were rejected. A downloaded file carries no record of the audience it came from, and the narrower audience can't be worked out. Warning also matches how the owner wants a shared Music folder to work.

### 3. Download rules and grouped transfers

**They wait for feedback.** Rules by kind and grouping transfers by folder stay parked in `docs/plans/downloads.md` until people who have used Save to… and folder downloads ask for them.

### 4. Losing the first device

**Accept it for v1.** The guide and the recovery-key screens tell people:

- keep the first computer and the recovery key safe;
- if either is stolen, start a new account.

If this is ever fixed, the preferred design is a separate root key that lives only in the recovery file (option 3 in the old question), because every device could then be revoked. Key rotation was rejected because it sets off the "verified key changed" warning for everyone.

### 5. People on several hubs

- **One person per `user_id`** in the People screen, with the hubs you know them on. Connections, groups and access stay per hub (ADR 0007), so each hub's actions and status are shown under that hub. The per-hub scope must stay obvious.
- **Display name:** the one from the first hub you joined (the first in `hubs.json`) where you know them.
- **Built (2026-10-13):** People merges by `user_id` (`people-merge.ts`). Requests, connections and waiting answers show one row per person, with a line per hub and that hub's actions. Find people and Groups get a hub picker. The sidebar badge counts people, not requests. Names follow the first hub in `useNames()` too.
- **Per-hub identities:** not planned. The guide says hub admins can tell that one person is on two hubs.

## Consequences

- The Backlog in `docs/progress.md` gets the agent first step, the re-share warning, the first-device guidance and merged people as ready-to-build items.
- `docs/questions.md` keeps only the ban-evasion note.
