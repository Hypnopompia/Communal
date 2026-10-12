# ADR 0007 — Clients on multiple hubs at once

- Status: accepted (owner decision, 2026-10-12). **Changes HANDOFF's single-hub client.**
- Date: 2026-10-12

## Context

HANDOFF assumes one hub per client: Settings has a single "Hub address" and the CLI has `init --hub`. The owner wants a client to join several hubs and connect to all of them from one running instance, so that **one search covers every hub at once**.

## Decision

1. **One identity everywhere.** The account root key, `user_id` and fingerprint are the same on every hub, and so are device keys and certs. Peers verify cert chains against the account root, never against a hub, so a transfer works the same whichever hub brokered it.
2. **Joining another hub from a linked device.** `account.create` takes optional `root_pubkey` + `chain`. The hub verifies that the chain leads from that root to the signing device, then registers the account under the root's `user_id`. Without these fields, the device is the root of a new account, as before. ~~If the account already exists on that hub, the hub returns `conflict`, and the device must be linked there instead.~~ Changed in M8 (ADR 0014): if the account already exists, a chain that verifies against that hub's revocations adds the device to it.
3. **Core: `HubManager`.** It runs one `HubClient` per configured hub with shared options. Every event is tagged with a local hub id (`h_…`). `requestAll()` sends the same request to every hub in parallel and reports a result per hub, so a slow or failing hub never blocks the others. A fatal error on one hub (banned, changed key) leaves the others running.
4. **Per-hub state** (`HubEntry {id, url, state}`): the pinned hub key, whether the device is registered, and the user/device ids. The headless client stores these in `hubs.json`. An older single-hub `hub.json` is migrated automatically.
5. **CLI:** `communal hub add <url> --name`, `hub list`, `hub remove <id|url>`. `init --hub` is kept (HANDOFF §11) and works like `hub add`. In dev builds, `COMMUNAL_HUB` accepts a comma-separated list for auto-join.
6. **No hub-protocol changes are needed** for fan-out. Each hub still filters search, browse and sources by its own access rules.

## Consequences for later milestones

- **M2 (search):**
  - Fan the query out with `requestAll` and merge results by content hash across hubs.
  - Each source keeps the hub it came from, because that hub brokers the connection and mints the transfer token.
  - Pagination cursors are per hub.
  - The UI shows partial results while slow hubs answer, and says which hubs are offline.
- **M2 (index):** each share is published to a chosen set of hubs. Each hub has its own `index_rev` and gets its own snapshots and deltas.
- **M3 (access): rules are per hub (owner decision, 2026-10-12).**
  - Every access rule is keyed by hub. The same file or folder can be "Everyone on the hub" on hub A and "Only me" on hub B. "Only me" is the default on every hub.
  - Each hub stores and enforces only its own rules.
  - The uploader keeps rules per hub and checks a request against the rules of the hub whose token it carries. A rule from one hub never grants access through another.
  - The UI must make the per-hub setting obvious, so a file public on one hub isn't mistaken as public everywhere.
  - Groups and connections are per hub too, though the UI may merge people by `user_id`.
- **M4 (transfers):**
  - The uploader accepts transfer tokens signed by **any hub it has joined and pinned**.
  - It checks the requester against **that hub's** access rules.
  - The upload log records which hub brokered each transfer.
- **M7 (subscriptions):** each watch belongs to one hub.
- **M8 (devices)** (done, ADR 0014):
  - Linking a device brings it onto every hub the account is on.
  - Revocations go to every hub.
  - Restore re-registers the account on each hub listed in the recovery data. The hub list could live in the recovery file.
- **Desktop (M9):** Settings → Hubs replaces the single "Hub address" field.

## Privacy note

One key everywhere lets the admins of different hubs (or anyone who can see two hubs) tell that the same person is on both. A per-hub identity is possible later but complicates devices and recovery. It's listed in `docs/questions.md`.
