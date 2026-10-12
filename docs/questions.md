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

- **Per-hub access rules (M3).** Is a share's audience set per hub, or once with hub-specific parts? ADR 0007 proposes per hub. A folder could be "everyone on hub A" and "only me" on hub B, with "only me" as the default on every hub.
- **Groups (M3).** Groups live on a hub and contain that hub's users. Should someone connected to you on two hubs appear as one person in the People screen? They have the same `user_id` everywhere, so merging is possible.
- **Display names** can differ per hub. Which one does the UI show for a person seen on several?
- **Privacy:** one key everywhere lets hub admins correlate a user across hubs. A per-hub identity option could come later if users ask for it.
