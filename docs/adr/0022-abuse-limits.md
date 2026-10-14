# ADR 0022 — Abuse limits on the hub

- Status: accepted. Built: everything below, in the hub, protocol, core, CLI, MCP and the desktop Manage screen.
- Date: 2026-10-14

A hub on the open internet in `open` join mode is reachable by anyone with its address. Before this, only link codes and subscriptions had limits. One script could create accounts without end, flood a session with searches, or upload an index of any size. The security audit of the same date (`docs/security-audit-2026-10.md`) found more of the same kind. This ADR records the limits and why they're shaped this way.

## Decision

### Three limits are hub settings

An admin can change these in Settings › Hubs › Manage › Settings, with `communal admin settings`, the MCP `set_hub_settings` tool, or `communal-hub set <key> <n>` on the server. They're stored in the `settings` table, every change goes in the audit log, and **0 means no limit**.

| Setting                   | Default   | What it counts                                                                                                                                   |
| ------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `signups_per_hour`        | 20        | New accounts **and** devices added to an account (`account.create`, `account.restore`) from one address in a sliding hour. Only successes count. |
| `max_files_per_device`    | 1,000,000 | Entries in one device's index on this hub.                                                                                                       |
| `max_devices_per_account` | 20        | Devices on one account, not counting revoked ones.                                                                                               |

- **An address is an IPv4 address, or an IPv6 /64.** A home or phone network usually gets a whole /64, so counting single IPv6 addresses would be no limit at all. The hub sees real client addresses because it terminates TLS itself (no proxy; see `communal-hub.env.example`).
- **20 sign-ups an hour** leaves room for a family setting up together behind one router, with two or three devices each.
- **Devices count as sign-ups** because a person holding their root key can sign certificates for as many new device keys as they like, without asking the hub. Each device brings its own index, so the per-device file limit also needs a per-account device limit.
- **A million files per device** is far above any library we've seen (the M2 scale test uses 100,000). It mainly puts an upper bound on what one account can store on the hub.
- When a device would go over its file limit, the snapshot page or delta is refused with `forbidden`, and the half-sent snapshot is thrown away. Swapping files or removing them is always allowed. Core logs the refusal as a warning and tries again on the next change.
- Over the device limit, `account.create`, `account.restore` and `link.approve` are refused with `forbidden` and a message saying to remove a device first.

### The rest are fixed

These are set in `apps/hub/src/limits.ts`. Only tests change them.

- **20 open connections per address.** Further ones are closed with 4029 before the challenge.
- **A message budget per session:** a token bucket of 1,000 that refills at 100 a second. Queries that scan the index or reach another device (`search`, `user.search`, `sources`, `browse`, `library`, `connect.request`, `index.snapshot`, `index.delta`) cost 4, and everything else costs 1.
  - **A session that runs out is slowed, not refused.** Its messages wait in order until the budget refills. Old clients never see a new error, and a legitimate burst (a sign-in with hundreds of subscriptions, a folder download walking 1,000 folders) just takes a little longer.
  - Pings and pongs skip the queue, so a throttled session isn't also dropped as silent.
  - A session with more than 2,000 messages or 32 MB waiting is closed with 4029.
- **Auth timeout counts from the connection,** not from the last message. Before this, an unauthenticated client could hold a connection forever by pinging.
- **NAT probes:** the responder answers only the exact client probe (`communal-probe`), at most 10 replies a second per address. Before this, any datagram of up to 64 bytes got a reply about four times its size, which could be used to bounce traffic at someone else.
- **Per account:** 100 groups, and 50 connection requests waiting for an answer.
  - Asking someone again while a request is already waiting changes nothing and doesn't notify them again.
  - Accepting someone else's request is never limited.
- **Per device:** 10,000 access rules, and 1,000 stored subscriptions. The old cap of 1,000 counted only the live session, while stored watches outlived it.
- **Per session:** 64 brokered connections waiting.
- **Banned accounts gain no new devices.**

### Names

Names that clients send (display names, device names, group names, the hub name) may not contain control characters or bidirectional overrides (U+202A–U+202E, U+2066–U+2069, U+200E/F, U+061C). Such characters can make a name read as someone else's. Zero-width joiners are allowed, because emoji sequences need them. Names the hub sends back still use the permissive schema, so a name stored before this check never breaks a client. Core's `safeName` also removes overrides from file names when saving, so `photo‮gpj.exe` can't be saved looking like `photoexe.jpg`.

## Consequences

- Per-address limits slow a script down, but they don't stop someone with many addresses. On a hub whose address gets around, `join_mode approval` remains the real defense, as `docs/questions.md` says about ban evasion.
- `admin.settings` gains three optional fields. Older clients ignore them. Newer clients hide the Limits panel for a hub that doesn't send them. `admin.settings.set` accepts them, and an older hub silently ignores them.
- `startTestHub` turns the per-address limits off (every test client is 127.0.0.1) and gives sessions a huge budget. Tests that check a limit turn it back on.
