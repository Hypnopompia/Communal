# Open questions

Requirements that need a decision before they're built, and spec gaps found along the way (HANDOFF §14). Each item says what's needed to settle it.

## Web admin UI for hubs (post-v1)

**Status:** wanted after v1 (owner, 2026-10-12). Not scheduled.

v1 admin is the `communal-hub` CLI only (HANDOFF §10). HANDOFF §15 defers a "hub admin view of the connection graph" but says not to design it out. The owner wants a web front end that can:

- change hub settings (join_mode, …)
- approve, ban and unban users
- show the social graph

What's already in place: every admin action is a `HubDb` method that the CLI wraps, and the hub already runs an HTTP(S) server (`/healthz`). A web UI would be a second front end on the same methods.

Needs deciding:

1. **Admin sign-in.** Today an admin is anyone with shell access to the hub. A web UI needs an admin identity. Proposal: flag certain accounts as hub admins (set from the CLI), and have them sign in to the admin UI with a device-key challenge, the same way clients sign in. That avoids adding passwords. A browser can't hold the device key, so this probably means a one-time sign-in link minted by a signed-in desktop client, or `communal-hub admin-link` on the server.
2. **Graph privacy.** HANDOFF promises that nobody learns who else can access a file (§6). The hub already knows the full connection graph and every group's membership. A graph view would put that in front of a person. Options:
   - show everything
   - show counts and degree only (no names on edges)
   - show it only for users who opt in
   - leave groups out entirely (they're private to their owner, §2)
3. **Where it's served.** On the same port and TLS certificate under `/admin`, or bound to localhost / a separate port so it's never exposed publicly by accident.
4. **Audit log** of admin actions: approvals, bans, setting changes.

## Ban evasion on open hubs

**Status:** known limitation, no action planned.

With no PII (§2), a banned person can generate a new key and join again. Hubs that care should use `join_mode approval`. Rate-limiting account creation per IP (planned before public deployment, see progress.md) helps a little.

## Multi-hub: cross-hub details still open

**Status:** decided in principle (ADR 0007). These details get settled in the milestones listed.

- **Groups (M3).** Groups live on a hub and contain that hub's users. Should someone connected to you on two hubs appear as one person in the People screen? They have the same `user_id` everywhere, so merging is possible.
- **Display names** can differ per hub. Which one does the UI show for a person seen on several?
- **Privacy:** one key everywhere lets hub admins correlate a user across hubs. A per-hub identity option could come later if users ask for it.

## Losing the first device

**Status:** known limitation in v1 (M8, ADR 0014). Needs an owner decision before any fix.

The account root is the first device's key. Every cert chain starts there, so that device **can't be revoked** without invalidating the whole account.

- A first device that is lost or broken is harmless. It just stays in the device list.
- A first device that is **stolen** (or a leaked recovery key) gives the thief the account for good. They can certify new devices, and nothing can revoke the root.

Options:

1. **Accept it for v1.** Tell people to keep the first device and the recovery key safe, and to start a new account if either is stolen.
2. **Account key rotation:** a new root signed by the old one, with clients and hubs following the rotation. Peers that verified the old fingerprint would need to see it change. The "verified key changed" warning (§2) would fire, which is right but alarming.
3. **Don't make the first device the root:** a separate root key that lives only in the recovery file and signs device certs during setup. Devices could then all be revoked, but linking would need the root key (or a delegation scheme).

## Download destinations and re-sharing

**Status:** first step built (ADR 0018, 2026-10-13): a downloads folder people choose, "Save to…", and whole-folder downloads. The rest waits for user feedback (owner). The full plan is in `docs/handoff-downloads.md`.

Still open:

1. **Rules by kind** (audio → Music, video → Movies), by extension, or neither, if Save to… turns out to be enough.
2. **Re-sharing and access.** A download saved into a shared folder takes that folder's audience. Someone who was shared a file privately could re-share it to the whole hub without noticing. Options:
   - warn before saving into a shared folder;
   - re-shared files start as "only me";
   - they take the narrower of the two audiences.
3. **Transfers grouped by folder**, with one progress bar for a folder download.

## Expanding what AI agents can do (MCP)

**Status:** ideas (owner request, 2026-10-13). Not scheduled. Suggested first step: tier 1 thumbnails plus the tier 2 access dry run.

ADR 0017's MCP server covers search, browse, downloads, shares, access, people, subscriptions and diagnostics. The ideas below would let an agent see what's in files, react to changes, and change access more safely. They're grouped by cost.

### Tier 1: the local API has it; MCP doesn't expose it

1. **Thumbnails as image content** (`/v1/thumbs`, `/v1/thumbs/:hash`). Agents read images, so returning thumbnails as MCP image content lets them sort photos, scans and video by what's in them, not just by name.
2. **Ranged reads** (`/v1/stream/:hash`). A "read part of a file" tool, for a PDF's first pages, a CSV header or a log tail, without downloading the whole file. It needs a size cap per call, and the same uploader checks as streaming.
3. **Events** (`/v1/events`). A "wait for event" or "changes since cursor" tool, so agents react ("tell me when this download finishes") instead of polling.

### Tier 2: small features in core or the hub

1. **Access dry run.** Given a proposed `acl` change, return which files become visible or hidden and to how many people, on which hub. It makes confirming `set_access` / `share_folder` meaningful, and the desktop UI could show the same preview. Must not reveal anything the owner couldn't already see.
2. **Explain one file's access.** For a path and hub: the rule in force, where it's inherited from (`rule_path`), and who it currently includes.
3. **Duplicate and gap reports.** Compare by hash across the library, this account's devices, and connections' visible shares: duplicates, files held in only one place, files someone has that this device doesn't.
4. **Search filters** on `files.meta`: kind, size, duration, date taken, artist/album/author. The data is already extracted, but search only matches text.
5. **Requests between people.** Ask for a file ("anyone have the 1998 recital video?"), watch for answers, download one when it appears. Needs a new hub message (ADR 0004) and the same visibility rules as search.
6. **Batch actions with a plan step.** Download, subscribe or set access on many items with one preview and one confirmation, instead of one per item.

### Tier 3: bigger features

1. **Search by content, on the device.** Extract text locally (pdf.js today, plus OCR or transcripts later) into a local full-text or embedding index. Content and embeddings never go to the hub.
2. **Asking questions across friends' shares.** A peer `hello.purpose` like `preview`: the owner's device runs the query and returns snippets, and the uploader checks access for every hash. Snippets reveal content, so this needs its own ADR. Should owners opt in per share?
3. **Agent-written metadata.** Tags, descriptions and captions stored locally, and optionally published with the index. Who can edit them, and do they follow the file's access rule?
4. **Saved automations.** Rules the core runs itself ("when something lands in Alice/Recipes, copy it to Notes"; a weekly summary of new files from connections), so an agent doesn't need to stay running.
5. **Audit log of agent actions.** A local record of every change made through MCP (access, shares, subscriptions, hubs), with undo where possible. Shown in the desktop app.

### Stays out of MCP

Per ADR 0017: the recovery key, device linking and revoking, and verifying people. If hub admin actions get a second front end (see "Web admin UI"), approvals and bans stay out too. Anything that widens an audience should go through the dry run or an explicit user confirmation.

### Needs deciding

1. Which tier-1 and tier-2 items to do, and in what order.
2. Does a dry-run result count as confirmation, or must the agent still ask the user every time an audience widens?
3. For content search and peer queries, how much content may leave the owner's device (none, snippets, or full text), and is it opt-in per share?
