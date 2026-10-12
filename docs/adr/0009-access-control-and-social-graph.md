# ADR 0009 — Access control, connections and groups

- Status: accepted (M3)
- Date: 2026-10-12

## Rules are per hub, and the client's copy is authoritative

- **Per hub.** Every rule belongs to one hub (ADR 0007, owner decision). The same folder can be "Everyone on the hub" on hub A and "Only me" on hub B. "Only me" is the default on every hub.
- **Stored on the device that holds the files.** The device keeps its rules in `index.db`, table `acl(hub, path, audience)`, and that copy is authoritative. The uploader re-checks against it before sending any byte (M4, HANDOFF §2).
- **Pushed with `acl.replace`, a new message.** The device sends its full rule set for a hub in one `acl.replace` on every sign-in and after every change. The hub replaces that device's rules atomically. So a hub restored from an old backup, or one that missed an update, is corrected on the next sign-in, and there's no rule-sync state to track. `acl.set` (HANDOFF §5) is still supported for single changes.
- **Only a device can set its own rules in M3.** `device_id` must be the session's device, so even another device of the same account is refused. Managing a NAS's rules from a laptop needs device-to-device sync of the authoritative copy, and belongs with devices (M8).
- **The CLI never guesses the hub.** `communal acl set` requires `--hub` when the device is on several hubs.

## Rule paths and inheritance (HANDOFF §6)

- **Paths:** a folder rule ends with `/` (`Photos/`, `Photos/2024/`), and a file rule is the file's path.
- **Effective rule:** the file's own rule, else the nearest ancestor folder's, else none, which means "only me".
- **An explicit `me` rule is a real rule.** It overrides a public parent folder.
- **How the hub stores it:** the hub writes the _governing rule path_ onto each entry (`entries.rule_path`). Entries are tagged when they're written, using a per-device rule cache, and all of that device's entries are re-tagged whenever its rules change. Visibility is then a join against the small rule tables rather than a path walk per entry.

## Who can see an entry (`Catalog.visible()`, the only place this is decided)

An entry is visible to viewer V if either of these holds:

1. **It's on one of V's own non-revoked devices.** Own devices see everything.
2. **Its governing rule allows V, and the owner isn't banned and the device isn't revoked.** A rule allows V when it is:
   - `hub`: V is signed in to this hub.
   - a list: V is listed by user id, or V is a member of a listed group **owned by the file's owner**. In both cases V and the owner must be **connected right now**.

**Consequences:**

- Removing a connection revokes access granted through it in the same request. There's no cache to invalidate.
- Listing someone who isn't connected grants nothing until they connect.
- A group id from someone else's account can't grant access, and `acl.set` / `acl.replace` reject one with `bad_request`.
- Browsing a device works only if the viewer can see at least one entry on it, or owns it. Otherwise the device is indistinguishable from one that doesn't exist.

## Connections

- **Lifecycle:** request → accept. Either side can remove, and that also declines or cancels a pending request. If both sides request each other, it counts as an accept.
- **Who can be reached:** only active, unbanned users other than yourself. Anything else returns `not_found`, the same as an unknown user.
- **Notifications:** the other side's online devices get `connection.request`, `connection.accept` or `connection.remove`. Presence for both people's devices is sent when they connect, and withdrawn with `online:false` when they disconnect, unless still visible some other way.
- **Removal also takes each person out of the other's groups.** Groups are built from connections (HANDOFF §2), so a group never quietly regains a member. Rules that list a user by id are the client's to keep, and they work again if the two reconnect.

## Groups

- **Owner-only.** Members can't list, edit or delete a group, and get `not_found` if they try.
- **Members must be accepted connections** when the group is created or updated.
- **`group.upsert` replies with a `group.listing`** containing that one group, so the caller learns a new group's id.

## Presence follows visibility

Presence goes to the owner's other devices, the owner's connections, and everyone on the hub if the owner has any rule shared with the whole hub. Their devices appear as sources, so whether they're online matters. Turning hub-wide sharing on or off announces or withdraws presence for everyone else.

## Identity checks on the client

A hub isn't trusted to report identities honestly. Every `UserSummary` from a hub must satisfy `user_id == userId(root_pubkey)` and `fingerprint == fingerprint(root_pubkey)`; anything else is dropped, or rejected with `hub_mismatch` (`People.checkSummary`).

`user_id` derives from the root key, so a verified person's key can't change without their `user_id` changing too. HANDOFF's "loud warning if a verified root key changes" therefore means, in practice, catching a hub that lies about someone's key, and that's what this check does.

**Safety codes** are derived from the two root fingerprints, so they're identical on both sides and on every hub. "Verified" is stored locally per `user_id` and fingerprint.

## User search

- Matches a prefix of the display name or of any word in it, case-insensitive. `LIKE` wildcards in the query are escaped, so they match literally.
- Only active, unbanned users are returned, never the person searching.
