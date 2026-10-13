# ADR 0015 — Source availability in search

- Status: accepted (M9)
- Date: 2026-10-12

An offline device's entries stay in the hub index until it signs in again and sends a new snapshot. Before M9, search and `sources.list` returned them with `online: false` and ranked them like any other hit. A file whose owner had been gone for weeks looked the same as one whose owner went to lunch, and a download from it sat in `waiting` (`peer_offline`).

## Decision

### Rounded `seen`, not a timestamp

Each source in `search.results` and `sources.list` carries `seen`, one of `now | today | week | month | older`:

- `now`: the device is online. This is the same as `online: true`.
- `today`: last connected less than 24 hours ago. It is a rolling 24 hours rather than a calendar day, so the bucket doesn't depend on anyone's time zone.
- `week`: under 7 days ago. `month`: under 30 days ago. `older`: anything else, including no record.

The hub knows each device's exact `devices.last_seen`, but search results go to anyone who can see the file, not just people who know the owner. Presence already tells viewers whether a device is online right now. An exact timestamp would add a history of when each person was active. Rounding gives the downloader what it needs ("will this come back soon?") without that history. The owner still sees exact `last_seen` for their own devices in `device.listing`.

### Filter: `search.available`

`search` takes an optional `available: now | today | week | month`. It keeps hits with at least one visible source seen that recently. When it's omitted, every hit is kept.

- The filter uses the same buckets as `seen`, not a number of days. A free `seen_within_days` would let a viewer bisect a file's sources down to the exact day, which would undo the rounding.
- It's a relevance filter, not an access rule, so it lives in `Catalog.search()` and not in `Catalog.visible()`.
- Online state lives in memory on the hub. The online device ids are passed into the SQL as JSON (`json_each(@online)`), so filtering and paging happen in the same query. Filtering after the query would break the offset cursors.

### Ranking

Hits are ordered by availability tier, then relevance (bm25), then newest:

1. some source online;
2. else some source seen within a week (`today` or `week`);
3. else stale (`month` or `older`).

FTS already requires every query word to match as a prefix, so every hit is a real match. Putting reachable files first is what a downloader wants, and it matches how Napster-style clients have always listed results. Within a tier, relevance decides as before.

The client merges hits from several hubs round-robin (ADR 0007), then stable-sorts by the same tiers. That keeps each hub's relevance order within a tier. Sources within a hit are sorted most-available first.

### Clients

- The core API's `GET /v1/search` takes `available`. `seenLabel()` in core turns a bucket into display text, which the CLI and desktop share.
- CLI: `communal search --online` or `--seen today|week|month`. Each hit shows "N online" or when its best source was last seen.
- Desktop: a "Show only available files" toggle (`available=week`), and each source shows its `seenLabel`.

## Not done

- **Retention.** Hiding a device's entries after X days unseen belongs with the hub admin UI (post-v1, `docs/questions.md`). The device's next snapshot would bring them back.
