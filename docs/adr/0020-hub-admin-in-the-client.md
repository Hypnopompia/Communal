# ADR 0020 — Hub administration from the client

- Status: accepted. Built: the hub side (protocol, database, handlers, `communal-hub admin` and `log`) and core (`HubAdmin`, the local API routes). The desktop screens, the CLI and MCP are next.
- Date: 2026-10-13

Today a hub admin is anyone with a shell on the hub, using `communal-hub` (HANDOFF §10). The plan was a separate web admin UI after v1, with open questions about sign-in, graph privacy and where to serve it (`docs/questions.md`, now removed). The owner chose a different shape: admin lives in the clients.

## Decision

### Owner decisions

- **The admin UI is in the clients, not a web page.** Clients manage a hub through new hub messages over the existing session (`wss://<hub>/v1`). The desktop app is the main front end, and the CLI and MCP use the same local API routes.
- **Admins are accounts.** The first account created on a hub becomes its admin. `communal-hub admin list|add <user_id>|remove <user_id>` manages admins from the shell. Like the other `communal-hub` commands, it works on the SQLite database alongside a live hub.
- **Settings › Hubs gets a Manage button** on each hub where you're an admin. It opens screens for:
  - hub settings
  - users
  - devices
  - the connection graph
  - the audit log
- **Only hub admins can see the graph.**
- **The hub keeps an audit log** of admin actions.
- **MCP gets hub admin tools,** for debugging and user management.

### What follows from that

These were open questions or details. They're decided here, and can be revisited.

- **No separate sign-in.** The hub session is already authenticated with the device key, so an admin is recognised by `user_id`. Every device on the account can manage the hub. No passwords, admin links or `/admin` HTTP routes are needed, and the hub opens no new port.
- **Admin rights are per hub**, like everything else (ADR 0007). Being admin on one hub means nothing on another.
- **Existing hubs:** the migration that adds admins makes the oldest account that isn't banned the admin. On a hub set up by its owner, that's the owner. Check with `communal-hub admin list` after upgrading.
- **On a new hub, the first account to sign up wins.** It's let in even in approval mode, since nobody could approve it from a client otherwise. The hub install script and `hub.html` tell the person running it to join first. `communal-hub admin add|remove` fixes a mistake.
- **Only the shell can make or remove admins.** That stays out of the client and MCP, so a stolen device or a misled agent can't take over a hub. An admin can't ban another admin from the client either. Use the CLI for that.
- **A banned account isn't an admin**, even while the flag is still set.
- **Enforcement on the hub.** Every admin message checks the session's account on the hub. Non-admins get the same error as an unknown message type, so they can't tell whether admin messages exist.
- **What admins see:**
  - **Users:** display name, `user_id`, status (pending, active, banned and why), created and last seen.
  - **Devices:** name, last seen, revoked, and the last network profile (NAT type and so on, ADR 0011), for debugging connections.
  - **Index counts per device:** files and total size. **No file names or paths.** The hub stores them, but the admin UI doesn't put people's files in front of another person.
  - **The graph:** accounts as nodes and accepted connections as edges, with pending requests shown differently. **Groups and access rules are left out.** Groups are private to their owner (HANDOFF §2), and nobody may learn who can see a file (§6).
- **Settings:** the hub name, `join_mode`, and (later) retention for devices that haven't been seen for a long time (ADR 0015).
- **The audit log** is a hub table `admin_log`: time, actor (`user_id`, or `cli`), action, target and details. Every admin `HubDb` method writes its entry in the same transaction, so no front end can skip it. CLI actions are logged too. Entries are kept, and there's no way to clear them yet. The Manage screen shows the log, newest first, and `communal-hub log` prints it.
- **One set of methods.** Every admin action stays a `HubDb` method. The CLI, the hub messages and through them the client and MCP are all front ends on those methods.
- **MCP** (amends ADR 0017's scope):
  - Tools for listing users, devices and the log; approving, banning and unbanning; and hub settings.
  - The hub refuses them unless the account is an admin.
  - Ban and settings tools are marked destructive. The server instructions tell the agent to confirm bans and approvals with the person first.
  - Adding or removing admins isn't a tool, because that's shell only.

## Protocol and tests

- The new admin messages go in `clientBodies`/`hubBodies`, with fixtures, and are recorded in ADR 0004. `welcome.admin` tells the client whether to show Manage, and an `admin.changed` hint tells open admin screens to refetch.
- Each one needs access-control cases (admin, non-admin, banned admin) in a new `apps/hub/src/admin.test.ts`.
- **Core:** `HubAdmin` (`core.admin`) wraps the messages and refuses early when `welcome.admin` was false. The hub checks again on every message, and an admin removed by the shell mid-session gets `forbidden`.
  - Hub status carries `admin`.
  - `admin.changed` becomes the `admin` event topic.
  - Renaming the hub updates the admin's own saved name at once. Everyone else picks it up on their next connection.
- **Local API routes:**
  - `GET /v1/hubs/:id/admin/users`
  - `POST /v1/hubs/:id/admin/users/:user/approve|ban|unban` (`ban` takes `{reason?}`)
  - `GET|PUT /v1/hubs/:id/admin/settings`
  - `GET /v1/hubs/:id/admin/graph`: people plus connections
  - `GET /v1/hubs/:id/admin/log?limit&before`
- The renderer wire types follow them, and `test/integration/m11-hub-admin.test.ts` covers the whole flow.

## Consequences

- HANDOFF §15's "hub admin view of the connection graph" is now planned, for admins only.
- Whoever administers a hub can see who is connected to whom on it, but never groups, rules or files. People joining someone else's hub should know that. Say so in `guide.html`.
- The CLI keeps working alone, so a hub can still be run with no client admin at all.
