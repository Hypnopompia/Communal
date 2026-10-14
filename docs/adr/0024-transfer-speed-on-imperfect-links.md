# ADR 0024 — Transfer speed on imperfect links (Wi-Fi)

- Status: accepted. The owner's slow Wi-Fi turned out to be a full link, not reordering (below). The libudx fix stays parked until a network that reorders shows up (`docs/questions.md`).
- Date: 2026-10-14

A 1.5 GB download between two of the owner's laptops on the same Wi-Fi ran at about 12 MB/s. On loopback the same download path does about 85 MiB/s. The question was whether our transport (udx-native + secret-stream, ADR 0001/0010) underuses a lossy, higher-latency link, and if so how to fix it.

## How it was measured

- **`docker/netem/test.sh`** (new): a hub and two clients on one Docker network. For each condition it shapes both clients' links with `tc netem` (on each side's egress, so `delay 2ms` means a 4 ms round trip). It then times a real download (node-b fetches a file that node-a shares, through the full core path: brokering, `Downloads`, BLAKE3 per chunk, disk writes) and the bare transport between the same two containers (`communal-spike`, one udx stream with Noise). `NETEM_UDX=<file>` swaps in another udx-native build, to A/B a libudx change.
- **`communal-spike`** gained `--streams N` (N udx streams on one socket, each with its own Noise session) and `--stats` (udx's cwnd, RTT, retransmits, fast recoveries and RTOs every second).
- **TCP comparison**: `iperf3` in one container under the same netem conditions on `lo` (MTU 1500).
- All on Docker Desktop on an M-series Mac (linux-arm64). Absolute numbers are higher than real Wi-Fi. The ratios are the point.

## What we found

### Loss and latency are fine. Reordering is not.

Lab, 512 MiB, MB/s, stock udx-native 1.21.3 (libudx `ae8bff7`):

| netem on each side      | Download | Spike (1 stream) |
| ----------------------- | -------- | ---------------- |
| none                    | 181      | 243              |
| `delay 2ms`             | 163      | 207              |
| `delay 2ms loss 0.5%`   | 126      | 135              |
| `delay 2ms reorder 1%`  | 115      | 132              |
| `slot 2ms 4ms` (bursty) | 182      | 181              |
| `delay 2ms 1ms`         | **3.8**  | 47               |
| `delay 3ms 1ms loss 1%` | **5.0**  | failed (> 120 s) |

- Random loss, a few ms of latency, a little reordering and bursty delivery (Wi-Fi-style aggregation, netem `slot`) all leave a download above 100 MB/s, close to the bare transport. The download window (32 × 1 MiB per source) and the per-chunk work aren't the limit.
- **Jitter collapses it.** netem's jitter reorders packets constantly, since each packet gets its own delay. TCP under the same `delay 2ms 1ms` still does 139 MB/s, so it's the transport, not the link.

### Why: libudx's reorder window rounds to zero on a LAN

libudx detects loss with RACK (RFC 8985). A packet counts as lost when a packet sent after it is acknowledged and more than `rack_rtt + reo_wnd` has passed. libudx sets `reo_wnd = min_rtt / 4` in whole milliseconds, and leaves out the RFC's adaptive part (a `TODO` in `rack_update_reo_wnd`). On a LAN `min_rtt` is 1 to 3 ms, so **the reorder window is 0 ms**: any packet overtaken by a later one is declared lost at once.

`--stats` under `delay 2ms 1ms` shows it: no RTOs, but about 190 fast recoveries and 1,400 retransmissions a second, and cwnd stuck at 10 to 35 packets. That is BBR re-entering recovery over and over for losses that never happened. The real download shows the same counters (instrumented in the lab). It suffers more than the spike, probably because its request traffic in the other direction is reordered too.

### The fix works, and it belongs in libudx

Three one-line patches to `rack_update_reo_wnd`, built for linux-arm64 and swapped in with `NETEM_UDX`:

| Spike, 128 MiB on `lo`, MB/s | stock | floor 1 ms | floor 2 ms | `srtt` once reordering is seen |
| ---------------------------- | ----- | ---------- | ---------- | ------------------------------ |
| `delay 2ms`                  | 125   | 121        | 122        | 107                            |
| `delay 2ms 1ms`              | 2–22  | 65         | 108        | 112                            |
| `delay 2ms 1ms loss 0.5%`    | 20    | 67         | 76         | 103                            |
| `delay 3ms 2ms`              | < 2   | < 2        | < 2        | 6                              |

With the `srtt` variant in the lab (512 MiB): `delay 2ms 1ms` went from 3.8 to **95 MB/s** for a download (spike 97), and `delay 3ms 1ms loss 1%` from 5.0 to **100 MB/s** (spike 111). `delay 2ms` was unchanged (163).

```c
// rack_update_reo_wnd(), libudx src/udx.c
  uint32_t r = udx_rtt_min(stream) / 4;
  if (stream->reordering_seen) r = stream->srtt; // the RFC's upper bound
  return r < stream->srtt ? r : stream->srtt;
```

This is the RFC's cap, applied at once rather than grown step by step on DSACKs. It only changes anything after reordering has been seen. It delays the detection of real losses by up to one RTT (a few ms on a LAN), which costs nothing measurable here. A proper upstream fix would grow the window (`reo_wnd_mult`) when a retransmission turns out to be spurious.

Stock results under jitter vary a lot from run to run (2 to 22 MB/s for the same condition); "< 2" means 128 MiB didn't finish in 60 s.

Heavy jitter (`delay 3ms 2ms`) still collapses with every variant. The sender's `srtt` then reads 1 ms while the real RTT is 6 to 10 ms, so the window stays tiny. That looks like a second libudx problem (RTT samples under reordering), to report along with the first.

### What doesn't help

- **Parallel streams per source.** Under `delay 2ms 1ms`, 2, 4 and 8 streams gave 15, 26 and 45 MB/s (spike), against about 100 with the patch. Under `delay 3ms 2ms`, 8 streams gave 13. Under bursty delivery they changed nothing. It's a lot of downloader complexity (several brokered sessions per source, upload slots) for a partial workaround, so we don't do it.
- **A bigger chunk window or more peers.** Without reordering, a download already gets 70 to 100% of the bare stream.
- **udx tuning from JavaScript.** udx-native exposes no congestion or RACK knobs.

### Is this what happened on the owner's Wi-Fi?

Not proven. 802.11 usually hands packets up in order (block-ack reorder buffers), but reordering does happen: a reorder buffer timing out after a retry, mesh points (the owner's 192.168.86.x network is a Google/Nest mesh), several links, or power-save. Two laptops on one access point also send every packet over the air twice, which roughly halves what either could do alone. 12 MB/s might simply be that link. Two things settle it:

1. **A baseline**: AirDrop or a Finder (SMB) copy of the same file between the same two laptops.
2. **The new link stats.** Core now logs udx's counters for each connection, on the uploader (`upload finished`, field `link`) and the downloader (`source finished` / `dropped source`). Many fast recoveries with few RTOs and a low `rtt_ms` mean the path reorders packets. The desktop app's core logs to stdout, so start it from Terminal on the uploading laptop: `/Applications/Communal.app/Contents/MacOS/Communal`. The counters are 16-bit in libudx and wrap at 65,536.

### The owner's Wi-Fi: saturated, not reordering (measured 2026-10-14)

The same 1.45 GB download between the two laptops on 0.1.8, about 14 MB/s. The uploader's `upload finished` line said `rtt_ms 56, cwnd 470, mtu 1500, retransmits 9898, fast_recoveries 218, rtos 0`. The uploader's Wi-Fi was 802.11ac at 866 Mbit/s (channel 149, 80 MHz, −46 dBm). Pinging the router gave 5 ms idle and 14 to 30 ms during the transfer.

- **Not the reordering bug.** That shows about 190 fast recoveries a second. This transfer had about 2 a second, with 1% retransmissions (ordinary Wi-Fi loss) and no RTOs.
- **The link is full.** The round trip grew from about 5 ms to 56 ms. That means a queue of roughly 700 KB building up in the Wi-Fi path (cwnd 470 × 1500 B, divided by 56 ms, is 12.6 MB/s). A sender held back by its own window wouldn't build a queue. Laptop → access point → laptop also sends every packet over the air twice.
- **So the libudx patch wouldn't help this case.** A Finder (SMB) copy between the same two laptops, through the same access point, is the fair comparison if we want to be sure. AirDrop goes laptop to laptop directly (AWDL) and skips the access point, so it isn't comparable.

## Decision

- **Keep udx-native and our transport as they are.** Loss and latency don't explain a slow link. No parallel streams, no window change. No relay, nothing in ADR 0001/0010 changes.
- **Ship the diagnosis tools:** the netem lab, the spike's `--streams`/`--stats`, and link stats in core's logs.
- **The fix is the libudx change above.** Getting it to users means either an upstream issue and PR to `holepunchto/libudx` (then a udx-native bump), or building and shipping our own udx-native prebuilds for every platform we release (macOS ×2, Windows ×2, Linux ×2, Android). That's the owner's call (`docs/questions.md`). A Finder baseline and the link stats from a real Wi-Fi download should come first, to show it's the problem the owner hit.
