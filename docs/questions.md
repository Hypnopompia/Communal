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

## Download destinations and folder downloads

**Status:** planned (owner request, 2026-10-12). Not scheduled.

Today every download lands in one folder (`~/Downloads/Communal`), or in a subscription's folder. The owner wants downloads organized by kind, and whole folders downloaded at once. For example: find an album in someone's shared Music, download the folder into `~/Music`, which is itself shared, so the album is re-shared and becomes another source for others.

What's already in place:

- Files are identified by content hash, so a re-shared copy is automatically an extra source for everyone downloading it (multi-source, ADR 0010).
- Subscriptions already download a folder tree and keep its structure (ADR 0013). A one-off folder download is the same without the watch.
- The indexer picks up new files in shared folders. The downloader writes `.part` files and renames them on completion, so a half-finished file is never shared.

Needs deciding:

1. **Rules.** Destination by kind (audio, video, image, document…), by file extension, or by MIME type? A per-download "Save to…" override? What happens when a rule's folder is missing?
2. **Structure.** For a folder download, keep the owner's folder name (e.g. `Music/Artist/Album/`)? Merge into an existing folder of the same name? Handle name clashes by renaming, skipping identical content (same hash), or asking?
3. **Re-sharing and access.**
   - A destination inside a share inherits that share's access rules: should the app say so before downloading ("this will be visible to everyone on the hub")?
   - Should re-sharing be opt-in per rule?
   - Re-sharing someone else's file to a wider audience than they chose would undo their choice. Should a re-shared copy default to the narrower of the two audiences, or should the app warn?
4. **Duplicates.** If the same content (hash) already exists locally, link or copy it instead of downloading again?
5. **API and UI.**
   - `POST /v1/downloads` takes a folder (`hub, device, path`).
   - Rules live in persisted settings (`settings.json`).
   - Settings gets a "Downloads" tab.
   - Library gets "Download folder", and Transfers groups a folder's files.
   - MCP: a `download_folder` tool.
