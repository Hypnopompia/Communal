# ADR 0011 — Connection diagnostics with no relay

- Status: accepted (M5)
- Date: 2026-10-12

HANDOFF §8: when two peers can't connect directly, nothing relays the data. Instead the downloader is told why (`cause`) and whose setup is easier to fix (`easier_fix`).

## Network check (client, `peer/netcheck.ts`)

Runs on every hub sign-in, and again on demand (`communal netcheck`, `POST /v1/network/check`). The result is sent to that hub as `network.profile`.

- **NAT type.** The peer socket itself sends to **both** of the hub's UDP probe ports at once. Probing from the peer socket matters, because the mapping it reveals is the one hole punching will use. A missing reply gets one retry.

  | What the probe ports saw                     | `nat`                  |
  | -------------------------------------------- | ---------------------- |
  | the same address and port                    | `endpoint_independent` |
  | different ports (or addresses)               | `symmetric`            |
  | one of our own interface addresses, our port | `none` (no NAT)        |
  | no reply from either port                    | `blocked` (no UDP)     |
  | one reply only, or the hub runs no probe     | `unknown`              |

  `none` and `blocked` are additions to the protocol's `NatType` (ADR 0004).

- **UPnP / NAT-PMP.** The library is `@achingbrain/nat-port-mapper` (v4, maintained by the libp2p team, ESM, both protocols). The alternatives are unmaintained or depend on the deprecated `request`: `nat-api`, `nat-upnp`, `nat-pmp`. The `@silentbot1/nat-api` fork pulls in browser shims.
  - NAT-PMP (asking the default gateway directly) and UPnP IGD (SSDP discovery) run at the same time with a 4 s budget, and the first mapping wins.
  - The default gateway comes from a small built-in lookup (`/proc/net/route`, `route -n get default`, `route print`) rather than another dependency.
  - The mapped address becomes a `mapped` candidate.
  - **Library quirk:** UPnP takes the lease in ms, but NAT-PMP writes `ttl` onto the wire as seconds and also uses it as a millisecond timer. NAT-PMP therefore gets a seconds TTL with `autoRefresh: false`, and we refresh it ourselves at half the lease.
  - Mappings are removed on shutdown.
  - **Off by default in `CommunalCore`**, so tests never touch the developer's real router. The headless daemon turns it on, and `COMMUNAL_UPNP=false` turns it off. The desktop app should turn it on too (M9).
- **`upnp`** means "a mapping is in place now", not "the router supports UPnP".
- **IPv6:** a global unicast address (2000::/3) on any interface.
- **CGNAT:** either the router's own external address (from NAT-PMP or UPnP) is in 100.64.0.0/10, or the hub sees us there. Without a UPnP/NAT-PMP router we can't see the router's external address, so CGNAT goes undetected. The diagnosis then falls back to `both_restrictive_nat`, whose tips still apply.
- **The hub keeps profiles in memory only**, on the session. A profile is resent after every sign-in. `HubServer.profileOf(device)` exposes it for diagnostics and a future admin UI.

## Reporting a failure (`connect.failed`)

1. **Both sides report** when hole punching finds no path (`no_path`), or finds one that the handshake can't use (`handshake_failed`). The report carries that hub's profile plus the punching stats: `attempts`, `udp_sent`, `udp_received`. An identity failure (`peer_rejected`) is a security event, not a network problem, and isn't reported. A downloader whose offer was never answered reports with zero stats.
2. **The owner's report is just recorded** (reply `ok`). It usually arrives first, because the owner starts punching when the offer arrives.
3. **The downloader's report is a request**, and the reply is the hub→client `connect.failed` with the diagnosis. If the owner's report isn't in yet, the hub waits up to `diagnosisWaitMs` (default 3 s). After that it judges the owner by its last `network.profile`.
4. **Only the two parties of a live brokered session may report.** Anyone else gets `not_found`. Only the downloader receives a diagnosis, and the session ends with it.
5. **The answer carries each side's four profile fields** (`nat`, `upnp`, `ipv6`, `cgnat`) but not the punching stats.

## Diagnosis (hub, `diagnosis.ts`, a pure function)

The first rule that matches wins:

1. **The owner never answered the offer** → `peer_offline`, fix `none`. An owner the hub already knows is offline gets `peer_offline` at `connect.request` time, as in M4.
2. **Either side `blocked`** → `udp_blocked`, fix on that side. If both are blocked, the fix is `you`, because your own network is the one you can change now.
3. **A side that should accept inbound packets** (`nat: none` or a UPnP mapping) heard nothing, while the other side heard it or didn't report → `os_firewall` on that side. If both match, the fix is `either`.
4. **Neither side reachable, and a CGNAT involved** → `cgnat`. The fix is on the non-CGNAT side, which can forward a port. If both are behind CGNAT, it's `either`, since either one getting a public IPv4 or IPv6 would do.
5. **Otherwise** → `both_restrictive_nat`. The fix is `either`, with two exceptions:
   - If one side's packets got through one way, the fix is on the side that filtered them.
   - If exactly one side is symmetric, the fix is on the **other** side. A port forward there is reachable from any of the symmetric side's random ports without configuration, while a forward on the symmetric side would also need an advertised address.

`easier_fix` is from the downloader's point of view: `you`, `them`, `either` or `none`.

## Client presentation

- **Transfers:** the most useful diagnosis among the sources (anything beats `peer_offline`) is stored on the transfer row (`transfers.diagnosis`, JSON). The download stays `waiting` and keeps retrying, since networks change and people fix routers. The diagnosis is kept until a newer one replaces it or the download completes. Sources the hubs already list as offline give `peer_offline` without any brokering.
- **`explain()`** (core `transfer/diagnosis.ts`) holds the HANDOFF §8 message and tips per cause. It rewords from the downloader's point of view (for example "The owner's firewall…") and adds one line on whose side to fix. The API's `GET /v1/downloads` returns it, `communal transfers` prints it, and the desktop app will reuse it.
- **`communal netcheck`** shows the NAT type per hub, the router mapping and external address, and what the profile means for direct connections.

## Known limits

- **A hub behind a reverse proxy that doesn't forward its UDP probe ports makes every client look `blocked`.** Operators must publish 3478/3479 UDP. If both sides come out `blocked`, suspect the hub first.
- **A UPnP mapping the router accepts but doesn't honour** is diagnosed as `os_firewall`. That's the most likely cause from the outside, but not the only one.
- **Profiles and observations are the clients' own claims.** A client lying about its network only misleads diagnoses of its own connections. Nothing in them is used for access control.

## Test lab

`docker/nat/test.sh` runs scenarios with each router in a chosen mode (`docker/nat/router.sh`):

- **`cone`:** `MASQUERADE`, so the mapping is endpoint-independent and inbound traffic is allowed only for replies.
- **`symmetric`:** `MASQUERADE --random-fully`, a new port per destination.
- **`udp_blocked`:** `cone` plus dropping all forwarded UDP.

| Scenario           | Expected outcome                                             |
| ------------------ | ------------------------------------------------------------ |
| cone / cone        | the transfer succeeds; then the owner stops → `peer_offline` |
| cone / symmetric   | `both_restrictive_nat`, fix `them`                           |
| cone / udp_blocked | `udp_blocked`, fix `you`                                     |

Each scenario also checks what the network check classified on both sides.

The routers have no default route and drop unsolicited packets to themselves, like a home router's WAN side. Before that, the lab leaked traffic between the private networks through Docker's gateway, and real punching between two cone NATs failed on a conntrack port clash (see the correction in ADR 0010).
