# Open questions

Requirements that need a decision before they're built, and spec gaps found along the way (HANDOFF §14). Each item says what's needed to settle it. Once a question is decided, its answer goes in an ADR and the item leaves this file: ADR 0020 (hub admin) and ADR 0021 (agents, re-sharing, the first device, people on several hubs) settled the last batch.

## Ban evasion on open hubs

**Status:** known limitation, no action planned.

With no PII (§2), a banned person can generate a new key and join again. Hubs that care should use `join_mode approval`. Per-address sign-up limits (ADR 0022) slow this down, but they don't stop it.

## Blocking people

**Status:** waiting for the owner.

Removing someone's connection request doesn't stop them from sending a new one at once, and each new request notifies you again (once per request since ADR 0022). Proposal: a per-hub block list. A blocked person's requests are dropped silently, they never see you in people search, and they can't see your presence. Blocking would remove an existing connection. The open questions:

- Should the blocked person be able to tell they're blocked? The proposal says no.
- Should a block also hide files you've shared with the whole hub from them? That needs a check in `Catalog.visible()`.
- Should admins see blocks in the graph?

## Slow transfers when the network reorders packets

**Status:** waiting for the owner. Detail and numbers: ADR 0024.

libudx counts any reordered packet as lost on a LAN, because its reorder window (`min_rtt / 4` in whole milliseconds) rounds to 0. Downloads then drop from over 100 MB/s to 4 or 5 MB/s in the netem lab. A one-line libudx change brings them back to about 100 MB/s. It isn't proven yet that this is why the owner's laptops got 12 MB/s on Wi-Fi. The questions:

- First, a baseline: how fast is AirDrop or a Finder copy of the same file between the same two laptops? And what do the new `link` stats in the uploader's log say during a slow download (many `fast_recoveries`, few `rtos`)?
- If reordering is confirmed, how do we ship the fix? (a) Open an issue and PR on `holepunchto/libudx` with the lab reproduction and wait for a udx-native release. This posts publicly, so it needs your go-ahead. (b) Build our own udx-native prebuilds for every platform we release and pin them, until upstream catches up. That costs a CI job and a fork to keep in step. (c) Both: (a) now, and (b) only if upstream is slow.
