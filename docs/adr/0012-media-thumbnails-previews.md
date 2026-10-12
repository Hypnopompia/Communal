# ADR 0012 — Metadata, thumbnails, previews and streaming

- Status: accepted (M6)
- Date: 2026-10-12

HANDOFF §9 and the preview parts of §7.

## Libraries

| Need                       | Choice                           | Why                                                                                                                                                                                                                                                                                                      |
| -------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Images, thumbnails as WebP | `sharp`                          | As suggested. Prebuilt libvips for every platform we target.                                                                                                                                                                                                                                             |
| EXIF date, embedded JPEG   | `exifr`                          | As suggested. Also extracts the JPEG preview that HEIC and camera RAW files embed (see below).                                                                                                                                                                                                           |
| Video                      | `ffmpeg-static` only             | **No ffprobe.** `ffprobe-static` is 350 MB because it bundles every platform, and the per-platform installers are unmaintained. ffmpeg's own input report (`ffmpeg -i`) has the duration, size and codec, so one binary does both. `COMMUNAL_FFMPEG` overrides it, and `ffmpeg` on PATH is the fallback. |
| Audio tags, cover art      | `music-metadata`                 | As suggested.                                                                                                                                                                                                                                                                                            |
| PDF pages, title, page 1   | `pdfjs-dist` + `@napi-rs/canvas` | pdf.js needs a canvas to render in Node, and `@napi-rs/canvas` is prebuilt with no system cairo. PDFs over 200 MB aren't opened.                                                                                                                                                                         |

pnpm's `allowBuilds` gains `ffmpeg-static` (its install step fetches the binary for the platform), `sharp` and `@napi-rs/canvas`.

**HEIC and camera RAW.** sharp's prebuilt libvips has no HEVC decoder, for patent reasons. Those formats get their size and date from EXIF, and their thumbnail from the JPEG preview the camera embeds. Files without one get no thumbnail.

## Owner side

- **The media worker** (`media/worker.ts`) runs after hashing (HANDOFF §9: "in the background after hashing"), and only while nothing is waiting to be hashed. That keeps a big first index fast: the 100k-file test still hashes and syncs in about 22 s.
- **For each hashed file:**
  - It records `meta`: the §9 fields, with displayed width and height after EXIF rotation.
  - It makes the 320 px WebP thumbnail, stored by hash under `<data>/thumbs/ab/<hash>-320.webp`.
  - It sets `files.media_at`.
- **Index changes:** a change is logged, and so a delta sent, only when `meta` or `thumb` actually changed. A file that can't be decoded costs nothing on the wire.
- **What resets it:** content changes (size or mtime) reset `meta`, `thumb` and `media_at`, just as they reset the hash.
- **Analysis by kind:**
  - Images: size and date from the file.
  - Video: a frame at 10 % of the duration.
  - Audio: the embedded cover.
  - PDF: page 1 on white.
  - Anything else gets `meta: {}` and no thumbnail.
- **ffmpeg runs with a hard timeout and an output cap,** since media files aren't trusted.
- **The 1600 px preview is rendered on demand** and then stored. Concurrent requests share one render. It's never enlarged beyond the original.
- **Thumbnail garbage collection:** every 6 h, thumbnails whose hash no share holds any more are deleted.

### EXIF/GPS stripping

sharp writes no EXIF, XMP, IPTC or ICC unless asked to, and the pipeline never asks. The image is auto-rotated first, so dropping the orientation tag doesn't leave it sideways. The tests check a source photo that does carry GPS and a camera make: the thumbnail has no EXIF block, exifr finds no GPS in it, and neither the make nor the `Exif` marker appears anywhere in its bytes.

## Peer protocol (additions in ADR 0004)

- **`hello.purpose`:** `file` (the default) or `preview`.
  - A preview session takes no download slot. It has its own cap of 8 sessions, and closes after 60 s idle.
  - It serves `thumb.get` and `peek` for any hash.
- **Access:** the hub only brokers a preview session for a hash the requester can see. The uploader then checks every requested hash against its own rules for the brokering hub (`AccessOracle`), exactly as for a download.
  - A refused hash gets `thumb.none` or `peek.none`, the same answer as a file with no thumbnail, so nothing is confirmed to exist.
  - LAN-only applies to previews too.
- **`peek.none`** is new. An empty `peek.data` would have looked like an empty file.
- **`peek`** sends the first 64 KB of a `text` or `code` file, with `truncated` set when the file is longer.
- **Upload log:** one `thumbnail` row per preview session (HANDOFF §7 "thumbnail batch"), with total bytes and the first served file's folder as the path. A session that only got refusals is logged as `denied`. Each peek gets a `file` row (`partial` unless the whole file fit).

## Viewer side

- **`Previews.fetch(hub, device, hashes, size)`**, used for a folder being browsed:
  - Cached hashes come straight from the cache.
  - The rest go to the owner's device over **one** preview session, with one `thumb.get` per 1,000 hashes (the protocol limit).
  - Concurrent requests for the same thumbnail share one fetch.
  - 500 thumbnails take about 250 ms on loopback.
- **`ThumbCache`:** files under `<data>/thumb-cache`, indexed in the local `thumb_cache` table, keyed by hash, so thumbnails are shared across owners and hubs. Least recently used entries are evicted above `media.thumbCacheBytes` (default 256 MB). Only a well-formed WebP under 1 MiB is accepted from a peer.
- **Streaming (`transfer/stream.ts`):**
  - A file session to the first online source, then the manifest, then chunks requested in order, 4 ahead of the reader.
  - Every chunk is verified before any of its bytes are served. A bad chunk is retried once, and then the stream ends.
  - The last 16 chunks are kept in memory, so seeking back is cheap, and nothing is written to disk.
  - An idle stream closes after 30 s.
- **Icons:** `iconFor(mime, name, kind)` returns a stable id from a fixed vocabulary (`pdf`, `spreadsheet`, `image-raw`, `subtitles`, …). Each UI maps the ids onto its own icon set (M9).

## Local API

| Route                                         | What                                                                |
| --------------------------------------------- | ------------------------------------------------------------------- |
| `GET /v1/browse`, `GET /v1/search`            | entries and hits now carry `icon`                                   |
| `POST /v1/thumbs {hub, device, hashes, size}` | fetch a batch into the cache; returns `{hash: available}`           |
| `GET /v1/thumbs/:hash?size=320\|1600`         | `image/webp`, cacheable forever (content-addressed); ours or cached |
| `GET /v1/peek?hub&device&hash`                | `{text, truncated}`                                                 |
| `GET /v1/stream/:hash?type=`                  | the file's bytes, with HTTP `Range` support (206, 416)              |

`communal browse` shows icon, size, metadata and a ▣ when there's a thumbnail. `communal peek` and `communal thumbs` are new.

## Known limits

- **Desktop media elements can't send the bearer token as a header.** `<img>` and `<video>` pointing at `/v1/thumbs` and `/v1/stream` need another way in. M9 will need a short-lived signed URL or a custom protocol in Electron.
- **The headless image's app layer grew from about 60 MB to 222 MB:** ffmpeg 49 MB, pdf.js 35 MB, the canvas library 29 MB, libvips 18 MB. pdf.js ships builds we don't use (`build/`, `web/`, source maps), which could be pruned at deploy.
- **Streams use one source.** If it disappears, the next read opens a new stream from another source, but an in-progress HTTP response ends.
