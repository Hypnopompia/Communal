# Plan: expanding what AI agents can do (MCP)

**Status:** first step decided (owner, 2026-10-13, ADR 0021): tier 1 thumbnails (built: `view_thumbnails`) plus the tier 2 access dry run (built: `preview_access`). The rest are ideas, not scheduled. Hub admin tools are planned separately (ADR 0020).

ADR 0017's MCP server covers search, browse, downloads, shares, access, people, subscriptions and diagnostics. The ideas below would let an agent see what's in files, react to changes, and change access more safely. They're grouped by cost.

## Tier 1: the local API has it; MCP doesn't expose it

1. **Thumbnails as image content** (`/v1/thumbs`, `/v1/thumbs/:hash`). Agents read images, so returning thumbnails as MCP image content lets them sort photos, scans and video by what's in them, not just by name.
2. **Ranged reads** (`/v1/stream/:hash`). A "read part of a file" tool, for a PDF's first pages, a CSV header or a log tail, without downloading the whole file. It needs a size cap per call, and the same uploader checks as streaming.
3. **Events** (`/v1/events`). A "wait for event" or "changes since cursor" tool, so agents react ("tell me when this download finishes") instead of polling.

## Tier 2: small features in core or the hub

1. **Access dry run.** Given a proposed `acl` change, return which files become visible or hidden and to how many people, on which hub. It makes confirming `set_access` / `share_folder` meaningful, and the desktop UI could show the same preview. Must not reveal anything the owner couldn't already see.
2. **Explain one file's access.** For a path and hub: the rule in force, where it's inherited from (`rule_path`), and who it currently includes.
3. **Duplicate and gap reports.** Compare by hash across the library, this account's devices, and connections' visible shares: duplicates, files held in only one place, files someone has that this device doesn't.
4. **Search filters** on `files.meta`: kind, size, duration, date taken, artist/album/author. The data is already extracted, but search only matches text.
5. **Requests between people.** Ask for a file ("anyone have the 1998 recital video?"), watch for answers, download one when it appears. Needs a new hub message (ADR 0004) and the same visibility rules as search.
6. **Batch actions with a plan step.** Download, subscribe or set access on many items with one preview and one confirmation, instead of one per item.

## Tier 3: bigger features

1. **Search by content, on the device.** Extract text locally (pdf.js today, plus OCR or transcripts later) into a local full-text or embedding index. Content and embeddings never go to the hub.
2. **Asking questions across friends' shares.** A peer `hello.purpose` like `preview`: the owner's device runs the query and returns snippets, and the uploader checks access for every hash. Snippets reveal content, so this needs its own ADR. Should owners opt in per share?
3. **Agent-written metadata.** Tags, descriptions and captions stored locally, and optionally published with the index. Who can edit them, and do they follow the file's access rule?
4. **Saved automations.** Rules the core runs itself ("when something lands in Alice/Recipes, copy it to Notes"; a weekly summary of new files from connections), so an agent doesn't need to stay running.
5. **Audit log of agent actions.** A local record of every change made through MCP (access, shares, subscriptions, hubs), with undo where possible. Shown in the desktop app.

## Stays out of MCP

Per ADR 0017: the recovery key, device linking and revoking, and verifying people. Hub admin actions (approvals, bans, settings) are in, for hub admins only (ADR 0020), but making someone an admin stays a `communal-hub` command. Anything that widens an audience should go through the dry run or an explicit user confirmation.

## Decided

See ADR 0021.

1. **First:** thumbnails as image content, then the access dry run.
2. **A dry run isn't a confirmation.** The agent still asks the person every time an audience widens, and shows the dry run's result in the question.
3. **Content leaving the owner's device** (content search across friends, peer queries): snippets only, never full text, and only from shares whose owner opted in. Off by default.
