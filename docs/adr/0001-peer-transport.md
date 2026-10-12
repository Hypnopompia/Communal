# ADR 0001 — Peer transport: udx-native + Noise (secret-stream)

- Status: accepted (M0 spike)
- Date: 2026-10-12

## Context

HANDOFF §3 asks for an encrypted, mutually authenticated, UDP-based transport that supports hole punching with **our own** signaling, has no relay fallback (or lets us disable it), builds for Electron + Linux + macOS + Windows (amd64 and arm64), and is fast on a 1 Gbps LAN. Three candidates:

1. `node:quic`
2. A maintained QUIC binding for Node
3. `udx-native` (reliable streams over UDP) + Noise via `@hyperswarm/secret-stream`

## Findings

**`node:quic`: ruled out.** The official Node 24.13 build doesn't expose it (`No such built-in module: node:quic`, even with `--experimental-quic`). It's still experimental upstream and would also have to be present in Electron's bundled Node.

**`@matrixai/quic` (quiche binding): ruled out.** v2.0.9 has had no release since 2025-08. Its prebuilds cover linux-x64, win32-x64 and darwin only, with **no linux-arm64**, and HANDOFF §13 requires amd64 + arm64 images. It would also need TLS certificates bridged to our Ed25519 device keys through custom verification callbacks.

**udx-native + secret-stream: chosen.**

- `udx-native` 1.21.3 ships prebuilds for darwin-{arm64,x64}, linux-{arm64,x64} and win32-{arm64,x64}, so there's no compile step in Docker.
- Both libraries are actively maintained (Holepunch, updated September 2026).
- `secret-stream` runs a **Noise XX handshake over Ed25519 keys** (`noise-curve-ed`), so **Communal device keys work directly** as transport identities with no key conversion and no certificates. The session uses libsodium secretstream (XChaCha20-Poly1305).
- Neither library relays traffic or uses a DHT. Those live in `hyperdht`/`hyperswarm`, which we don't depend on. `secret-stream` has an inert `relay` metadata field used only by hyperdht. `udx`'s `stream.relayTo()` is an in-process forwarding API that we never call.
- Signaling is entirely ours: each side needs only the peer's IP, port and stream id. Those travel in `connect.offer` / `connect.answer`.
- Hole punching works the usual way: both sides send raw datagrams from the same UDP socket that carries the streams, then connect.

## Spike results

`spike/transport/src/bench.ts` moves N bytes between two processes:

- The downloader initiates Noise XX with its device key.
- Each side checks that `deviceId(remotePublicKey)` equals the device it expected.
- The two sides exchange cert chains and verify them with `verifyCertChain` against the expected account root.
- The data then streams in 1 MiB writes, with a SHA-256 end-to-end check.

| Run                                                                 | Bytes | Time                              | Throughput                           | Integrity |
| ------------------------------------------------------------------- | ----- | --------------------------------- | ------------------------------------ | --------- |
| Two processes, macOS loopback (M-series, 14 cores)                  | 1 GiB | 8.3–8.7 s                         | ~125 MB/s (~1.0 Gbps)                | ✅ ×3     |
| Two containers on the compose network (Docker Desktop, linux-arm64) | 1 GiB | 3.7 s                             | ~287 MB/s (~2.3 Gbps)                | ✅        |
| Wrong identity (`--peer mallory`)                                   | —     | —                                 | rejected: `peer device key mismatch` | ✅        |
| Two hosts on a LAN                                                  | 1 GiB | _pending, needs a second machine_ |                                      |           |

On macOS loopback the bottleneck is CPU in the kernel UDP path. Each process keeps about one core busy, mostly system time: 6.3 s user + 11.4 s sys for 9 s wall time across both processes. Linux is about 2.3× faster on the same hardware. That gives enough headroom for 1 Gbps LAN links on Linux. On macOS it's roughly at line rate, and if that ever matters, a future optimization is batched sends (`sendmmsg`/GSO, which udx is working toward).

## Decision

Use `udx-native` + `@hyperswarm/secret-stream` for the peer transport.

- **Authentication.** The Noise static key is the device's Ed25519 key. After the handshake, the peer must:
  1. match the `device_id` the hub named in `connect.offer`, and
  2. present a cert chain that verifies to the account root and contains no revoked devices.

  The spike sends the chain in a first control frame. In M4, the chain arrives in the `connect.offer` body instead (the `from_chain` field), and the uploader checks it again on `hello`.

- **Addressing.** udx accepts **IP literals only**, so every candidate must be an IP address. The `COMMUNAL_ADVERTISE_ADDR` hostnames used in dev must be resolved before use.
- **Stream ids.** Each connection needs a pair of udx stream ids. These will be added to `connect.offer` / `connect.answer` in M4. The spike uses fixed ids.
- **No relay, ever.** `hyperdht` and `hyperswarm` must not become dependencies. If one ever does, its relay and DHT features must be disabled.

## Consequences

- Our own framing (HANDOFF §7: length-prefixed msgpack headers plus raw payload) runs over a reliable, ordered, encrypted byte stream. One udx stream per transfer session keeps it simple. Multiplexing several logical streams over one connection is possible later.
- Native modules in Electron: udx-native is an N-API prebuild loaded in the core `utilityProcess`. It needs a smoke test under Electron in M9.
